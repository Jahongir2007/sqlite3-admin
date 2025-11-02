const sqlite3 = require("sqlite3").verbose();
const db = new sqlite3.Database("test.db");

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    email TEXT,
    age INTEGER
  )`);

  const stmt = db.prepare("INSERT INTO users (name, email, age) VALUES (?, ?, ?)");
  stmt.run("Alice", "alice@example.com", 25);
  stmt.run("Bob", "bob@example.com", 30);
  stmt.run("Charlie", "charlie@example.com", 28);
  stmt.finalize();

  db.run(`CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,
    content TEXT,
    author_id INTEGER
  )`);

  db.run(`INSERT INTO posts (title, content, author_id) VALUES
    ('Hello World', 'My first post', 1),
    ('Node + SQLite', 'It works perfectly', 2)
  `);
});

db.close();
console.log("✅ test.db created successfully!");
