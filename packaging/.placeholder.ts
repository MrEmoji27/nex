// Rewrite the discovery engine block in NexAppImpl with correct Bun UDP APIs:
// Bun.udpSocket is async, returns Socket with send(data, port, address):boolean.
// networkInterfaces comes from node:os. All typed loosely at the socket edge.

const OLD = /  \/\*\* Bring up UDP beaconing \(announce \+ listen \+ sweep\) unless disabled\. \*\/[\s\S]*?  private async stopDiscovery\(\): Promise<void> \{[\s\S]*?\n  \}\n/

export {}
