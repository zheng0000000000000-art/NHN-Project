import { stdin, stdout } from 'node:process';

export async function readPassword(prompt = 'Password: ') {
  if (!stdin.isTTY) throw new Error('Password is required through --password or TEAM_LOOP_PASSWORD when stdin is not a TTY.');
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
    };
    const onData = (character) => {
      if (character === '\u0003') {
        cleanup();
        stdout.write('\n');
        reject(new Error('Cancelled.'));
        return;
      }
      if (character === '\r' || character === '\n') {
        cleanup();
        stdout.write('\n');
        resolve(value);
        return;
      }
      if (character === '\u007f' || character === '\b') {
        value = value.slice(0, -1);
        return;
      }
      value += character;
    };
    stdin.on('data', onData);
  });
}
