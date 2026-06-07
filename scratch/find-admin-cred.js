const fs = require('fs');
const readline = require('readline');

const logPath = 'C:\\Users\\red\\.gemini\\antigravity\\brain\\e58878b7-2a30-4221-9f77-0d4213855460\\.system_generated\\logs\\transcript.jsonl';

const rl = readline.createInterface({
  input: fs.createReadStream(logPath),
  output: process.stdout,
  terminal: false
});

rl.on('line', (line) => {
  try {
    const obj = JSON.parse(line);
    if (obj.step_index >= 170 && obj.step_index <= 180) {
      console.log(`Step ${obj.step_index} (${obj.source} - ${obj.type}):`);
      console.log(`Content: ${obj.content ? obj.content.substring(0, 1000) : ''}\n`);
    }
  } catch (e) {
    // ignore
  }
});
