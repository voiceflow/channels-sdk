// The Voiceflow function behind every server tool. It holds no logic and no
// credentials: it sends what the model gave it to your server, with the turn's
// pass, and returns what your server answers.
//
// Like every function this package installs, it reaches Voiceflow as its text
// (functionSource), so it is self-contained and uses nothing Voiceflow's
// sandbox lacks. The formatter leaves this folder alone: the text is hashed by
// version in each channel package's tests.

/** `__CHANNELS_TOOL__` is replaced with the tool's name when the function's source is built. */
export async function callServerTool(args: any) {
  const input = args.inputVars || {};
  const url = String(input.channels_tools_url || '').trim();
  const pass = String(input.channels_turn_pass || '').trim();
  const failed = (result: string) => ({ outputVars: { ok: false, result }, next: { path: 'error' } });
  if (!url || url === '0') return failed("This tool isn't connected to a server yet: its channels_tools_url secret has no value.");
  // The pass goes only where nobody on the way can read it.
  if (!/^https:\/\/\S+$/.test(url)) return failed("This tool's server address must start with https://, so it wasn't called.");
  // A variable nobody set reads as 0.
  if (!pass || pass === '0') return failed("This only works in a conversation on a connected channel, where the server knows who's asking.");
  const values: Record<string, unknown> = {};
  for (const key of Object.keys(input)) {
    if (key !== 'channels_tools_url' && key !== 'channels_turn_pass') values[key] = input[key];
  }
  let res: any;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${pass}`, 'x-voiceflow-tool-call': '1' },
      body: JSON.stringify({ tool: '__CHANNELS_TOOL__', input: values }),
    });
  } catch (error) {
    return failed("I couldn't reach the server that runs this.");
  }
  // Voiceflow's fetch carries `json` as a property; a standard one, as a method.
  let data: any;
  try {
    data = typeof res.json === 'function' ? await res.json() : res.json;
  } catch (error) {
    data = undefined;
  }
  if (!data || typeof data !== 'object' || typeof data.result !== 'string') return failed(`The server that runs this answered ${res.status}.`);
  const outputVars: Record<string, string | number | boolean> = { ok: data.ok === true, result: data.result };
  const extra = data.outputs && typeof data.outputs === 'object' ? data.outputs : {};
  for (const key of Object.keys(extra)) {
    const value = extra[key];
    if (key !== 'ok' && key !== 'result' && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')) outputVars[key] = value;
  }
  return { outputVars, next: { path: outputVars.ok ? 'success' : 'error' } };
}
