// Browser component tests never read or write the system clipboard.
export const setStringAsync = async (_value: string) => undefined;
export const getStringAsync = async () => "";
