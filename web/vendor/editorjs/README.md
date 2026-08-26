# Vendored Editor.js

These are the unmodified UMD builds from the `@editorjs/*` npm packages, copied
here rather than loaded from a CDN.

**Why vendored.** The page must make zero external network requests at runtime —
the footer promises that nothing leaves this machine, and a CDN script tag would
make that false. It also has no build step, so a bundler-only distribution is not
an option; every file here sets a browser global and works from a plain
`<script>` tag.

**Licences.** `@editorjs/editorjs` is Apache-2.0; every plugin is MIT. Both are
compatible with this repository's MIT licence. The upstream licence text ships
inside each package in `node_modules/@editorjs/*/LICENSE`.

**Re-vendoring.** Bump the versions in `package.json`, `npm install`, then:

    for p in editorjs header list quote code table delimiter marker \
             inline-code underline simple-image; do
      cp node_modules/@editorjs/$p/dist/*.umd.js web/vendor/editorjs/
    done

Nothing here is edited by hand. If a file differs from its package, re-copy it.
