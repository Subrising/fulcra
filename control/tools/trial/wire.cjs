// Keep proof receipts aligned with the actual protocol envelope; never retain raw frames.
exports.rpcResponse = (frame) => {
  const message = frame?.type === "session" ? frame.message : null;
  const payload = message?.type === "plugin.rpc.invoke.response" ? message.payload : null;
  return payload && typeof payload.requestId === "string" ? payload : null;
};

exports.jsonReceipt = (value) => JSON.stringify(value ?? null);
