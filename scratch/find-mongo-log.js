const fs = require('fs');
const readline = require('readline');
const path = require('path');

const logPath = 'C:\\Users\\red\\.gemini\\antigravity\\brain\\e58878b7-2a30-4221-9f77-0d4213855460\\.system_generated\\logs\\transcript.jsonl';

const rl = readline.createInterface({
  input: fs.createReadStream(logPath),
  output: process.stdout,
  terminal: false
});

rl.on('line', (line) => {
  if (line.includes('mongodb+srv') || line.includes('mongodb://') || line.includes('MONGODB_URI')) {
    try {
      const obj = JSON.parse(line);
      console.log(`Step ${obj.step_index} (${obj.source} - ${obj.type}):`);
      // truncate content to 200 chars for readability
      const content = obj.content ? obj.content.substring(0, 300) : '';
      console.log(`Content: ${content}\n`);
    } catch (e) {
      // ignore
    }
  }
});
