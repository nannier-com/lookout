// Writes the MIT LICENSE into the package immediately before it is packed for npm.
//
// lookout follows the canvas split: the SOURCE in this repository is not licensed
// (all rights reserved), while the PUBLISHED PACKAGE consumers install is MIT. A
// LICENSE file at the repository root is how GitHub decides a repository's licence,
// so it is generated at pack time (and gitignored) rather than committed.
//
// Run automatically by `prepublishOnly`. Safe to run by hand: it writes one file.

import fs from "node:fs";

const YEAR = "2026";
const HOLDER = "Robert Nannier";

const TEXT = `MIT License

Copyright (c) ${YEAR} ${HOLDER}

This license applies to this distributed package (the compiled output published to
npm as @nannier/lookout). The project's source repository is not covered by it and
remains all rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

fs.writeFileSync(new URL("../../LICENSE", import.meta.url), TEXT);
console.log("licensegen: wrote LICENSE (package-only MIT grant)");
