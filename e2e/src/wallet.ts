/*
 * The wallet the recordings inject as `window.ethereum`. It is a test wallet on a local chain, not
 * MetaMask, and the video says so. It holds no key. Every method goes straight to anvil's JSON-RPC
 * unchanged, except account sharing: like any wallet it shares no account until the page asks with
 * eth_requestAccounts, and the account it shares is whichever anvil account the test selected.
 */
export const testWalletScript = (rpcUrl: string) => `(() => {
  const RPC = ${JSON.stringify(rpcUrl)};
  let id = 0;
  let connected = false;
  window.__testWalletIndex = 0;
  const rpc = async (method, params) => {
    const response = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: params || [] }) });
    const body = await response.json();
    if (body.error) { const e = new Error(body.error.message); e.code = body.error.code; e.data = body.error.data; throw e; }
    return body.result;
  };
  window.ethereum = {
    isTestWalletOnLocalChain: true,
    request: async ({ method, params }) => {
      if (method === 'eth_requestAccounts') connected = true;
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') {
        if (!connected) return [];
        const all = await rpc('eth_accounts');
        return [all[window.__testWalletIndex]];
      }
      return rpc(method, params);
    },
    on() {},
    removeListener() {},
  };
})();`;
