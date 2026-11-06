/*
 * The board's wallet for the live run. It is a page script that stands in for `window.ethereum`. Reads
 * go to the Sepolia RPC. A signing request (eth_sendTransaction) is handed to a Node function that runs
 * `cast send --account <keystore> --password-file <path>` (e2e/live/cast.ts), so the board's key
 * stays in Foundry's keystore and this code never opens it or its password file. The page only ever
 * learns the transaction hash. The board's address is the public `board()` of the deployed registry.
 */
export const castWalletScript = (rpcUrl: string, boardAddress: string) => `(() => {
  const RPC = ${JSON.stringify(rpcUrl)};
  const BOARD = ${JSON.stringify(boardAddress)};
  let id = 0;
  let connected = sessionStorage.getItem('test-wallet.connected') === '1';
  const rpc = async (method, params) => {
    const response = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: params || [] }) });
    const body = await response.json();
    if (body.error) { const e = new Error(body.error.message); e.code = body.error.code; e.data = body.error.data; throw e; }
    return body.result;
  };
  window.ethereum = {
    isCastBackedTestWallet: true,
    request: async ({ method, params }) => {
      if (method === 'eth_requestAccounts') { connected = true; sessionStorage.setItem('test-wallet.connected', '1'); }
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return connected ? [BOARD] : [];
      if (method === 'eth_sendTransaction') {
        const tx = params[0];
        return await window.__castSend(tx.data, tx.to);
      }
      return rpc(method, params);
    },
    on() {},
    removeListener() {},
  };
})();`;
