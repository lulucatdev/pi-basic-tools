# pi-basic-tools

Standalone basic tools for pi.

This package bundles a practical set of editing, search, file-navigation, and web-reference extensions split out from `pi-goodstuff`.

## Installation

```bash
pi install git:github.com/lulucatdev/pi-basic-tools
```

## Update

```bash
pi update git:github.com/lulucatdev/pi-basic-tools
```

## Included extensions

- `multi-edit`
- `files`
- `fetch`
- `glob`
- `grep`
- `list`
- `answer`
- `sourcegraph`

## Bundled support files

- `extensions/lib/ripgrep.ts`
- `bin/rg-darwin-arm64`

## Notes

- `glob`, `grep`, and `list` use the bundled ripgrep helper and binary when a system `rg` is unavailable.
- `multi-edit` depends on the `diff` npm package, which is installed through package dependencies.

## License

MIT
