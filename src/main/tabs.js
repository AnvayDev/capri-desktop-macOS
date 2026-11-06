'use strict';

// Closing your browser tabs by what's in them, when you ask her ("close my YouTube tabs"): every tab
// whose address or title has those words, in the browsers that are open. macOS, through each
// browser's own AppleScript (macOS asks once per browser whether Capri may control it). Firefox has
// none: its tabs stay. Opening a tab is her [[site]] tag (launch.js).

const mac = require('./mac');

// the browsers that can be told, by app name; Safari calls a tab's title its name
const BROWSERS = [
  ['Safari', 'name'], ['Google Chrome', 'title'], ['Microsoft Edge', 'title'], ['Brave Browser', 'title'],
  ['Arc', 'title'], ['Vivaldi', 'title'], ['Chromium', 'title'], ['Opera', 'title'],
];

const running = (name) => mac.osascript(`application ${mac.asString(name)} is running`, 5000).then((r) => r === 'true', () => false);

// { closed, browsers: [names], denied: [names macOS didn't let her control] }
async function closeTabs(query) {
  const q = String(query || '').trim().slice(0, 100);
  if (!mac.MAC || q.length < 2) return null;
  const result = { closed: 0, browsers: [], denied: [] };
  for (const [app, title] of BROWSERS) {
    if (!(await running(app))) continue;
    const script = `set q to ${mac.asString(q)}
set n to 0
tell application ${mac.asString(app)}
  repeat with w in windows
    set c to count of tabs of w
    repeat with i from c to 1 by -1
      set t to tab i of w
      if ((URL of t) as text) contains q or ((${title} of t) as text) contains q then
        close t
        set n to n + 1
      end if
    end repeat
  end repeat
end tell
return n`;
    try {
      const n = Number.parseInt(await mac.osascript(script, 20000), 10) || 0;
      result.closed += n;
      if (n) result.browsers.push(app);
    } catch (err) {
      // -1743: you said no (or haven't been asked yet) in Privacy & Security › Automation
      if (/-1743|not allowed|Not authorized/i.test(err.message)) result.denied.push(app);
    }
  }
  return result;
}

// Asks each browser that's open for something harmless (how many windows it has), so macOS asks you
// right away whether Capri may control it, and she shows up in Privacy & Security › Automation.
// { allowed: [names], denied: [names], none: true when no browser she knows is open }
async function askAccess() {
  const result = { allowed: [], denied: [], none: false };
  for (const [app] of BROWSERS) {
    if (!(await running(app))) continue;
    try {
      await mac.osascript(`tell application ${mac.asString(app)} to count windows`, 60000); // the prompt waits for you
      result.allowed.push(app);
    } catch {
      result.denied.push(app);
    }
  }
  result.none = !result.allowed.length && !result.denied.length;
  return result;
}

module.exports = { closeTabs, askAccess };
