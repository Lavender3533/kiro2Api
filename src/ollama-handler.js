// Stub file - not used for Kiro provider
export async function handleOllamaRequest() { return { handled: false, normalizedPath: '' }; }
export async function handleOllamaShow(req, res) {
    res.writeHead(404);
    res.end('Not supported');
}
