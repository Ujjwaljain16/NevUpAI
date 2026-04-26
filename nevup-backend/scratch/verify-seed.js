const fs = require('fs');
const { parse } = require('csv-parse/sync');

const raw = fs.readFileSync('nevup_seed_dataset.csv', 'utf8');
const records = parse(raw, { columns: true, skip_empty_lines: true });

const users = new Set(records.map(r => r.userId));
const sessions = new Set(records.map(r => r.sessionId));

console.log('Total Trades:', records.length);
console.log('Total Users:', users.size);
console.log('Total Sessions:', sessions.size);

const minDate = new Date(Math.min(...records.map(r => new Date(r.entryAt))));
const maxDate = new Date(Math.max(...records.map(r => new Date(r.entryAt))));

console.log('Date Range:', minDate.toISOString(), 'to', maxDate.toISOString());
