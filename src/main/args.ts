export interface NodeArgs {
  name?: string
  port?: number
  dataDir?: string
  mock?: boolean
  /** Protective tier: passphrase-wrapped vault (unrecoverable if lost). */
  passphrase?: string
  /** Explicit opt-out of local encryption entirely. */
  plaintext?: boolean
}

/** Parse --name/-n, --port/-p, --data-dir/-d, --mock, --passphrase from the command line. */
export function parseArgs(argv: readonly string[]): NodeArgs {
  const args: NodeArgs = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = argv[i + 1]
    switch (arg) {
      case "--name":
      case "-n":
        if (value) {
          args.name = value
          i++
        }
        break
      case "--port":
      case "-p":
        if (value && /^\d+$/.test(value)) {
          args.port = Number(value)
          i++
        }
        break
      case "--data-dir":
      case "-d":
        if (value) {
          args.dataDir = value
          i++
        }
        break
      case "--mock":
        args.mock = true
        break
      case "--passphrase":
        if (value) {
          args.passphrase = value
          i++
        }
        break
      case "--plaintext":
        args.plaintext = true
        break
    }
  }
  return args
}
