# linkOS

[Link to the video](https://youtu.be/4DE3MBMngz8)

Welcome to linkOS, a small Virtual Machine that lives entirely inside a URL - no server, installation or other dependencies needed.

Open `dist/index.html` in a browser while developing. The exported `data:text/html` URL is standalone and contains the application, virtual filesystem, and machine state; it does not depend on local project files.

The actual sources are in `src/`:

- `src/index.template.html`
- `src/styles.css`
- `src/app.js`

The default OS image is in `src/rootfs/`. 
Every file in that directory is packed into the virtual filesystem using its relative path:

- `src/rootfs/workspace/main.js` => `/workspace/main.js`
- `src/rootfs/workspace/preview.html` => `/workspace/preview.html`

Build artifacts are generated with:

- `npm run build` writes compressed/minified release artifacts to `dist/index.html` and `dist/linkos.url`
- `npm run build:dev` writes readable development artifacts
- `npm run build:empty` writes a release artifact without packing any rootfs files
- `npm run build:rootfs -- path/to/rootfs` packs a different root filesystem directory

`dist/linkos.url` is the copy-pasteable data URL artifact.
There is also a sample url in `samples/linkos.url`.

The app boots into a small desktop with:

- a terminal with a small Unix-like command set
- a virtual filesystem
- an editor
- a worker-backed process monitor
- a lightweight Browser window
- Export URL and Reset buttons that handle (re-)generation of VM URLs.

The generated URL includes the current virtual filesystem and window state in its hash. When available, LinkOS compresses the state payload with `CompressionStream`. Paste the URL into a browser tab and it restores the machine from the hyperlink.

Useful terminal commands:

- `help`
- `pwd`
- `cd /workspace`
- `ls -l`
- `grep worker main.js`
- `nano main.js`
- `xdg-open .`
- `xdg-open preview.html`
- `run main.js`
- `ps`
- `kill <pid>`
- `whoami`
- `setuser <name>`
- `diff <path-a> <path-b>`
- `export`
