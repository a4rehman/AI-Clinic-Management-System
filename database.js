const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./clinic.db');

db.serialize(() => {
    // Patients table
    db.run(`CREATE TABLE IF NOT EXISTS appointments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        patient_name TEXT,
        patient_phone TEXT,
        appointment_date TEXT,
        appointment_time TEXT,
        status TEXT DEFAULT 'pending'
    )`);

    // Available slots (for simulation)
    db.run(`CREATE TABLE IF NOT EXISTS slots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT,
        time TEXT,
        is_available INTEGER DEFAULT 1
    )`);

    // Seed some initial slots if empty
    db.get("SELECT COUNT(*) as count FROM slots", (err, row) => {
        if (row.count === 0) {
            const times = ["09:00", "10:00", "11:00", "14:00", "15:00", "16:00"];
            const today = new Date().toISOString().split('T')[0];
            times.forEach(t => {
                db.run("INSERT INTO slots (date, time) VALUES (?, ?)", [today, t]);
            });
            console.log("Database initialized with sample slots.");
        }
    });
});

module.exports = db;
