#!/usr/bin/env node
// index.js
// Usage: node index.js path/to/database.db
// or     npx sqlite3-admin ./mydb.db

const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const open = require("open");
const multer = require("multer");
const fs = require("fs");

const upload = multer({ storage: multer.memoryStorage() });
const uploadSql = multer({ dest: "uploads/" });
// --- CLI ARG: path to DB file ---
const dbPath = process.argv[2];
if (!dbPath) {
  console.error("❌ Please provide a SQLite database file path.");
  console.error("Example: npx sqlite3-admin ./mydb.db");
  process.exit(1);
}

// --- Connect to SQLite ---
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) console.error("DB connection error:", err.message);
  else console.log(`✅ Connected to DB: ${dbPath}`);
});

// --- Express setup ---
const app = express();
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const settingsData = JSON.parse(fs.readFileSync('settings.json','utf8'));
// --- Home route: list all tables ---
app.get("/", (req, res) => {
  db.all("SELECT name FROM sqlite_master WHERE type='table'  AND name NOT LIKE 'sqlite_%';", [], (err, tables) => {
    if (err) return res.send("Error loading tables: " + err.message);
    const raw = fs.readFileSync('settings.json','utf8');
    const settings = JSON.parse(raw);
    res.render("index", { tables, settings });
  });
});

// --- Table route: show table rows ---
app.get('/table/:name', (req, res) => {
  const tableName = req.params.name;

  db.all(`SELECT * FROM ${tableName} LIMIT ?`, [settingsData.rows_per_page], (err, rows) => {
    if (err) return res.status(500).send(err.message);

    // Always get column info
    db.all(`PRAGMA table_info(${tableName});`, (err, columnsInfo) => {
      if (err) return res.status(500).send(err.message);

      // If table empty, build empty row
      let dataRows = rows.length > 0 ? rows : [{}];
      if (rows.length === 0) {
        columnsInfo.forEach(c => (dataRows[0][c.name] = ''));
      }
      const raw = fs.readFileSync('settings.json','utf8');
      const settings = JSON.parse(raw);
      res.render('table', {
        tableName,
        rows: dataRows,
        columns: columnsInfo.length > 0 ? columnsInfo : Object.keys(rows[0] || {}),
        settings
      });
    });
  });
});

// --- SQL query route (AJAX) ---
app.post("/query", (req, res) => {
  const { query } = req.body;
  if (!query) return res.json({ error: "Query is required" });

  db.all(query, [], (err, rows) => {
    if (err) return res.json({ error: err.message });
    const raw = fs.readFileSync('settings.json','utf8');
    const settings = JSON.parse(raw);
    res.json({ result: rows, settings});
  });
});

app.get('/tables', (req, res)=>{
  db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';", [], (err, tables)=>{
    if(err) return res.send("Error loading tables: " + err.message);
    const raw = fs.readFileSync('settings.json','utf8');
    const settings = JSON.parse(raw);
    res.render('tables', {tables, settings});
  });
});

app.post('/tables/remove/:name', (req, res) => {
  const { name } = req.params;

  // Check if name is valid (avoid SQL injection)
  if (!/^[a-zA-Z0-9_]+$/.test(name)) {
    return res.json({ success: false, error: 'Invalid table name' });
  }

  const query = `DROP TABLE IF EXISTS "${name}"`;

  db.run(query, function(err) {
    if (err) {
      return res.json({ success: false, error: err.message });
    }
    return res.json({ success: true });
  });
});

app.post('/tables/create', (req, res) => {
  const { name, columns } = req.body;

  if (!name || !columns)
    return res.json({ success: false, error: 'Missing name or columns' });

  if (!/^[a-zA-Z0-9_]+$/.test(name))
    return res.json({ success: false, error: 'Invalid table name' });

  const query = `CREATE TABLE IF NOT EXISTS "${name}" (${columns})`;

  db.run(query, function(err) {
    if (err) return res.json({ success: false, error: err.message });
    res.json({ success: true });
  });
});

app.post('/tables/rename/:oldName', (req, res) => {
  const { oldName } = req.params;
  const { newName } = req.body;

  // Validate names to prevent SQL injection
  const valid = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
  if (!valid.test(oldName) || !valid.test(newName)) {
    return res.json({ success: false, error: 'Invalid table name' });
  }

  const query = `ALTER TABLE "${oldName}" RENAME TO "${newName}"`;

  db.run(query, function(err) {
    if (err) return res.json({ success: false, error: err.message });
    return res.json({ success: true });
  });
});

app.get('/table/:name/structure', (req, res) => {
  const tableName = req.params.name;

  db.all(`PRAGMA table_info(${tableName});`, [], (err, pragma) => {
    if (err) return res.status(500).send(err.message);

    db.get(
      `SELECT sql FROM sqlite_master WHERE type='table' AND LOWER(name)=LOWER(?)`,
      [tableName],
      (err2, tableSql) => {
        if (err2) return res.status(500).send(err2.message);

        const createSQL = (tableSql && tableSql.sql) ? tableSql.sql.toUpperCase() : '';

        pragma.forEach(col => {
          const colName = col.name.toUpperCase();

          // ✅ Check if this exact column has AUTOINCREMENT
          const pattern = new RegExp(`"${colName}"\\s+INTEGER\\s+PRIMARY\\s+KEY\\s+AUTOINCREMENT`, 'i');
          col.ai = pattern.test(createSQL);
          console.log(col.ai);
          console.log(createSQL);
          // console.log(tableSql);

          // ✅ Optional: fallback for INTEGER PRIMARY KEY without AUTOINCREMENT
          if (!col.ai && !/INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT/.test(createSQL) && col.pk) {
            col.ai = false; // just a PK, not AI
          }
        });

        // 👀 Optional debug
        console.log("Detected autoincrement:", pragma.map(c => ({ name: c.name, ai: c.ai, pk: c.pk })));
        const raw = fs.readFileSync('settings.json','utf8');
        const settings = JSON.parse(raw);
        res.render('structure', { name: tableName, columns: pragma, settings });
      });
  });
});

app.post('/table/:name/structure/addcolumn', (req, res) => {
  // const db = new sqlite3.Database('./database.db');
  const tableName = req.params.name;

  const {
    newColumn,
    newColumnType,
    oldColumns,
    primarKey,
    autoIncrement,
    notNull,
    defVal,
    len
  } = req.body;

  try {
    if (!newColumn || !newColumnType) {
      return res.status(400).json({ error: 'Missing column name or type' });
    }

    // ✅ Convert JSON safely
    console.log(oldColumns);
    const cols = JSON.parse(JSON.stringify(oldColumns));

    // ✅ Build column type
    let typeDef = newColumnType.toUpperCase();
    if (len && ['VARCHAR', 'CHAR', 'NVARCHAR'].includes(typeDef)) {
      typeDef += `(${len})`;
    }

    // ✅ Constraints
    const constraints = [];
    if (primarKey) constraints.push('PRIMARY KEY');
    if (autoIncrement && typeDef === 'INTEGER') {
      if (!constraints.includes('PRIMARY KEY')) constraints.push('PRIMARY KEY');
      constraints.push('AUTOINCREMENT');
    }
    if (notNull) constraints.push('NOT NULL');
    if (defVal !== null && defVal !== undefined && defVal !== '') {
      constraints.push(`DEFAULT '${defVal}'`);
    }

    const newColDef = `"${newColumn}" ${typeDef} ${constraints.join(' ')}`.trim();
    const oldColNames = cols.map(c => `"${c.name}"`).join(', ');
    const oldDefs = cols.map(c => {
      let def = `"${c.name}" ${c.type}`;

      // ✅ Add primary key and autoincrement
      if (c.pk === 1 || c.pk === true) {
        def += ' PRIMARY KEY';
      }
      if ((c.ai === 1 || c.ai === true) && c.type.toUpperCase() === 'INTEGER') {
        def += ' AUTOINCREMENT';
      }

      // ✅ Add NOT NULL
      if (c.notnull === 1 || c.notnull === true) {
        def += ' NOT NULL';
      }

      // ✅ Add DEFAULT value if exists
      if (c.dflt_value !== null && c.dflt_value !== undefined) {
        def += ` DEFAULT '${c.dflt_value}'`;
      }

      return def;
    }).join(', ');
    cols.forEach(col =>{
      if(col.pk == 1 && col.ai){

      }
    });
    console.log(oldDefs);
    const tempTable = `temp_${tableName}`;
    const createSQL = `CREATE TABLE IF NOT EXISTS ${tempTable} (${oldDefs}, ${newColDef});`;
    const insertSQL = `INSERT INTO ${tempTable} (${oldColNames}) SELECT ${oldColNames} FROM ${tableName};`;

    db.serialize(() => {
      db.run('BEGIN TRANSACTION;');
      db.run(createSQL, (err) => {
        if (err) throw err;
        db.run(insertSQL, (err) => {
          if (err) throw err;
          db.run(`DROP TABLE IF EXISTS ${tableName};`, (err) => {
            if (err) throw err;
            db.run(`ALTER TABLE ${tempTable} RENAME TO ${tableName};`, (err) => {
              if (err) throw err;
              db.run('COMMIT;');
              res.json({ success: true, message: `Column '${newColumn}' added successfully!` });
            });
          });
        });
      });
    });
  } catch (err) {
    console.error('❌ Error adding column:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/table/:name/structure/deletecolumn', (req, res) => {
  const tableName = req.params.name;
  const { columnToDelete } = req.body;

  db.all(`PRAGMA table_info(${tableName});`, (err, columns) => {
    if (err) return res.status(500).json({ error: err.message });

    // ✅ Step 1: get original CREATE TABLE SQL
    db.get(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name=?`,
      [tableName],
      (err2, row) => {
        if (err2) return res.status(500).json({ error: err2.message });

        const originalSQL = row ? row.sql : '';

        // ✅ Step 2: detect which column has AUTOINCREMENT
        const autoIncCols = [];
        columns.forEach(c => {
          const pattern = new RegExp(`"${c.name}"\\s+INTEGER[^,]*AUTOINCREMENT`, 'i');
          autoIncCols.push({ ...c, ai: pattern.test(originalSQL) });
        });

        // ✅ Step 3: filter out the column to delete
        const remainingCols = autoIncCols.filter(c => c.name !== columnToDelete);

        // ✅ Step 4: rebuild column definitions safely
        const defs = remainingCols.map(c => {
          let def = `"${c.name}" ${c.type}`;
          if (c.pk === 1) def += ' PRIMARY KEY';
          if (c.ai) def += ' AUTOINCREMENT';
          if (c.notnull) def += ' NOT NULL';
          if (c.dflt_value !== null) def += ` DEFAULT '${c.dflt_value}'`;
          return def;
        }).join(', ');

        const colNames = remainingCols.map(c => `"${c.name}"`).join(', ');
        const tempTable = `temp_${tableName}`;

        const createSQL = `CREATE TABLE ${tempTable} (${defs});`;
        const insertSQL = `INSERT INTO ${tempTable} (${colNames}) SELECT ${colNames} FROM ${tableName};`;
        const dropSQL = `DROP TABLE ${tableName};`;
        const renameSQL = `ALTER TABLE ${tempTable} RENAME TO ${tableName};`;

        db.serialize(() => {
          db.run('BEGIN TRANSACTION;');
          db.run(createSQL);
          db.run(insertSQL);
          db.run(dropSQL);
          db.run(renameSQL);
          db.run('COMMIT;');
          res.json({ success: true, message: `Column '${columnToDelete}' deleted successfully!` });
        });
      }
    );
  });
});

app.post('/table/:name/structure/update', (req, res) => {
  const { name } = req.params;
  const { oldColumn, newColumn, newpk, newai, newnn, newColumnType, newDefVal } = req.body;

  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    return res.status(400).json({ success: false, error: 'Invalid table name' });
  }

  db.get(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`, [name], (err, row) => {
    if (err) return res.status(500).json({ success: false, error: err.message });
    if (!row) return res.status(404).json({ success: false, error: 'Table not found' });

    const createSQL = row.sql;

    db.all(`PRAGMA table_info(${name})`, [], (err, columns) => {
      if (err) return res.status(500).json({ success: false, error: err.message });

      // detect AUTOINCREMENT from original SQL
      const autoIncCols = [];
      createSQL.replace(/"(\w+)"\s+INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT/gi, (_, colName) => {
        autoIncCols.push(colName);
      });

      const updatedColumns = columns.map(col => {
        const isAI = autoIncCols.includes(col.name);

        if (col.name === oldColumn) {
          return {
            ...col,
            name: newColumn || col.name,
            type: newColumnType || col.type,
            notnull: newnn ? 1 : 0,
            dflt_value: newDefVal || null,
            pk: newpk ? 1 : col.pk,
            ai: newai ? 1 : isAI
          };
        }

        return { ...col, ai: isAI };
      });

      // build new CREATE TABLE SQL
      let sql = `CREATE TABLE temp_${name} (`;
      sql += updatedColumns.map(col => {
        let def = `"${col.name}" ${col.type}`;
        if (col.notnull) def += ' NOT NULL';
        if (col.dflt_value !== null && col.dflt_value !== '') def += ` DEFAULT '${col.dflt_value}'`;
        if (col.pk && col.ai && col.type.toUpperCase() === 'INTEGER') {
          def += ' PRIMARY KEY AUTOINCREMENT';
        } else if (col.pk) {
          def += ' PRIMARY KEY';
        }
        return def;
      }).join(', ');
      sql += ');';

      console.log("✅ Generated CREATE SQL:", sql);
      console.log("Detected autoincrement:", updatedColumns.map(c => ({ name: c.name, ai: c.ai })));

      // perform DB operations
      db.serialize(() => {
        db.run(`DROP TABLE IF EXISTS temp_${name}`);
        db.run(sql, (createErr) => {
          if (createErr) return res.status(500).json({ success: false, error: createErr.message });

          const oldCols = columns.map(c => `"${c.name}"`).join(', ');
          const newCols = updatedColumns.map(c => `"${c.name}"`).join(', ');

          db.run(`INSERT INTO temp_${name} (${newCols}) SELECT ${oldCols} FROM ${name}`, (insertErr) => {
            if (insertErr) return res.status(500).json({ success: false, error: insertErr.message });

            db.run(`DROP TABLE ${name}`, (dropErr) => {
              if (dropErr) return res.status(500).json({ success: false, error: dropErr.message });

              db.run(`ALTER TABLE temp_${name} RENAME TO ${name}`, (renameErr) => {
                if (renameErr) return res.status(500).json({ success: false, error: renameErr.message });
                return res.json({ success: true });
              });
            });
          });
        });
      });
    });
  });
});

app.post('/table/:name/insert', (req, res) => {
  const tableName = req.params.name;
  const { rowData } = req.body;

  const keys = Object.keys(rowData).filter(k => rowData[k] !== '');
  const values = keys.map(k => rowData[k]);
  const placeholders = keys.map(() => '?').join(', ');

  const sql = `INSERT INTO ${tableName} (${keys.join(', ')}) VALUES (${placeholders})`;

  db.run(sql, values, function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, message: `Row inserted successfully!` });
  });
});

app.post('/table/:name/remove-row', (req, res)=>{
  const { name } = req.params;
  const { rowId } = req.body;

  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    return res.status(400).json({ success: false, error: 'Invalid table name' });
  }

  db.run(`DELETE FROM ${name} WHERE id = ?`, [rowId], (err)=>{
    if(err) return res.status(500).json({error: err.message});
    res.json({success: true, message: "Row deleted!"});
  });
});

app.post('/table/:name/edit-row', (req, res)=>{
  const { name } = req.params;
  const { rowId, ...rowData } = req.body;

  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    return res.status(400).json({ success: false, error: 'Invalid table name' });
  }

  const cols = Object.keys(rowData);
  const vals = Object.values(rowData)

  const setSQL = cols.map(c => `${c} = ?`).join(', ');

  db.run(`UPDATE ${name} SET ${setSQL} WHERE id = ?`, [...vals, rowId], (err) => {
    if (err) return res.json({ error: err.message });
    res.json({ success: true });
  });
});

app.get('/table/:name/import-export', (req, res)=>{
  const {name} = req.params;
  const raw = fs.readFileSync('settings.json','utf8');
  const settings = JSON.parse(raw);
  res.render('import-export', {name, settings});
});

// ✅ Export a table as CSV
app.get('/table/:name/export/csv', (req, res) => {
  const { name } = req.params;

  db.all(`SELECT * FROM ${name} LIMIT ?`, [settingsData.rows_per_page], (err, rows) => {
    if (err) return res.status(500).send(err.message);
    if (!rows || rows.length === 0) return res.status(404).send("No data found");

    // Convert to CSV
    const headers = Object.keys(rows[0]);
    const csvRows = [headers.join(",")];
    rows.forEach(row => {
      const values = headers.map(h => JSON.stringify(row[h] ?? "")); // safely escape
      csvRows.push(values.join(","));
    });

    const csv = csvRows.join("\n");

    res.header("Content-Type", "text/csv");
    res.attachment(`${name}.csv`);
    res.send(csv);
  });
});


// ✅ Export a table as JSON
app.get('/table/:name/export/json', (req, res) => {
  const { name } = req.params;

  db.all(`SELECT * FROM ${name} LIMIT ?`, [settingsData.rows_per_page], (err, rows) => {
    if (err) return res.status(500).send(err.message);
    res.header("Content-Type", "application/json");
    res.attachment(`${name}.json`);
    res.send(JSON.stringify(rows, null, 2));
  });
});


// ✅ Import CSV into a table
app.post('/table/:name/import/csv', upload.single("file"), (req, res) => {
  const { name } = req.params;
  const csvData = req.file.buffer.toString("utf8").trim();

  const lines = csvData.split("\n").map(l => l.trim()).filter(l => l);
  const headers = lines[0].split(",").map(h => h.replace(/"/g, ""));
  const placeholders = headers.map(() => "?").join(",");

  const stmt = db.prepare(`INSERT INTO ${name} (${headers.join(",")}) VALUES (${placeholders})`);

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(",").map(v => v.replace(/^"|"$/g, ""));
    stmt.run(values);
  }

  stmt.finalize(err => {
    if (err) return res.status(500).send(err.message);
    res.redirect(`/tables/${name}`);
  });
});

app.get('/tools', (req, res)=>{
  const raw = fs.readFileSync('settings.json','utf8');
  const settings = JSON.parse(raw);
  res.render('tools', {settings});
});

app.get('/import-export/sql', (req, res)=>{
  const raw = fs.readFileSync('settings.json','utf8');
  const settings = JSON.parse(raw);
  res.render('import-sql', {settings});
});

app.post("/import-sql", uploadSql.single("sqlfile"), (req, res) => {
  try {
    if (!req.file) return res.send("No file uploaded");

    const sql = fs.readFileSync(req.file.path, "utf8");
    fs.unlinkSync(req.file.path);

    // split into separate statements
    const statements = sql
      .split(";")
      .map(s => s.trim())
      .filter(s => s.length > 0);

    let results = [];

    statements.forEach(stmt => {
      try {
        db.exec(stmt);
        results.push({query: stmt, status: "✅ OK"});
      } catch(err) {
        results.push({query: stmt, status: "❌ ERROR: " + err.message});
      }
    });
    const raw = fs.readFileSync('settings.json','utf8');
    const settings = JSON.parse(raw);
    // send results to template
    res.render("import-result", { results, settings });

  } catch (err) {
    console.error(err);
    res.send("Import error: " + err.message);
  }
});

// GET settings page
app.get('/settings', (req,res)=>{
  const settings = JSON.parse(fs.readFileSync('./settings.json','utf8'));
  const raw = fs.readFileSync('settings.json','utf8');
  const settingsSelf = JSON.parse(raw);
  res.render('settings', { settings, settingsSelf });
});

// POST save settings
app.post('/settings', (req,res)=>{
  const newSettings = {
    dark_mode: req.body.dark_mode === 'on',
    confirm_delete: req.body.confirm_delete === 'on',
    rows_per_page: parseInt(req.body.rows_per_page)
  };

  fs.writeFileSync('./settings.json', JSON.stringify(newSettings, null, 2));
  res.redirect('/settings');
});

const { exec } = require('child_process');
const { create } = require("domain");
const { error } = require("console");

function openBrowser(url) {
  const plat = process.platform;
  if (plat === 'win32') {
    // windows
    exec(`start "" "${url.replace(/"/g, '\\"')}"`);
  } else if (plat === 'darwin') {
    // macOS
    exec(`open "${url.replace(/"/g, '\\"')}"`);
  } else {
    // linux (xdg-open)
    exec(`xdg-open "${url.replace(/"/g, '\\"')}"`);
  }
}

// Start server
const PORT = 1234;
app.listen(PORT, () => {
  console.log(`🌐 SQLite3 Admin running at http://localhost:${PORT}`);
  openBrowser(`http://localhost:${PORT}`);
});