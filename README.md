# ged-tools

Node.js utilities for GEDCOM editing and genealogy archive research. Includes
FamilySearch, PRDH (Québec), Archion, Matricula, GRO and FreeBMD adapters.
Requires Node.js 22 or later. Playwright is an optional peer dependency needed
by GRO, PRDH search/record, and FamilySearch books/tree-audit commands; the
remaining commands use native HTTP or the Chrome DevTools Protocol (CDP).

This package is [MIT licensed](LICENSE). Source and releases are available at
[rjwalters/ged-tools](https://github.com/rjwalters/ged-tools). Tests are synthetic
and offline. Extraction tests do not establish that an external site's current
interface works; no live queries or paid downloads were made to validate this
extraction. Existing site-specific limits and failure classifications are retained.

## Library

```js
import { buildModel, loadGed, applyPatches } from '@rjwalters/ged-tools';
const model = buildModel('0 @I1@ INDI\n1 NAME Synthetic /Alpha/\n0 TRLR');
console.log(model.people.I1.name);

const ged = loadGed('input.ged');
ged.set('I1', 'BIRT.DATE', '1 JAN 1900');
ged.save('output.ged');
```

Core subpaths are `/gedcom`, `/ged-edit`, and `/patches`. Archive helpers use
`/lib/<module>` and command implementations use `/scripts/<command>`, without
`.js`. These research interfaces are experimental. The package root imports
only the GEDCOM core; loading an archive module does not open a browser.

`buildModel` is a permissive, lossy reading model, not a conformance validator.
`loadGed` preserves untouched bytes. Use `setWrapped` to replace continuation
text, `appendFact` for an additional fact, and `addPointer`/`removePointer` for
relationships. Callers must verify referential integrity. `save` is synchronous,
not an atomic transaction. `applyPatches` mutates the supplied model.

## Commands

Install the package into a consuming project, then use its local CLI:

```sh
npm install --save-exact @rjwalters/ged-tools@0.2.2
npx --no-install ged-tools --help
npx --no-install ged-tools --project /path/to/project fs-catalog --help
```

For browser commands, start a debug Chrome and sign in yourself. Acquire its
lock for the entire batch and declare the same holder name for every command:

```sh
npx --no-install ged-tools browser-lock acquire research
export BROWSER_LOCK_HOLDER=research
# Run research commands sequentially here.
npx --no-install ged-tools browser-lock release research
```

Archion uses a separate browser and lock; add `--browser archion` to the lock
commands. No command logs in to an account on import. Archion's explicit
`login` command reads caller-provided credentials; never put credentials in argv.

| Command | Purpose |
|---|---|
| `fs-catalog` | Catalog/place searches, film lists, viewer-access classification |
| `fs-film` | Browse or retrieve film frames, with session and download checks |
| `fs-fulltext` | Full-text search, per-image OCR, film membership and session probes |
| `fs-personas` | Indexed-record searches, including Scottish collections |
| `fs-image` | Retrieve an image by caller-supplied ARK |
| `fs-books` | Search a book's indexed text |
| `fs-audit` | Compare a supplied tree root with a local GEDCOM (`--root PID=GED-ID`) |
| `prdh-couples`, `prdh-familles` | List-only queries with URL guards against metered record endpoints |
| `prdh-search` | Act-index search: surname, optional given name/year range |
| `prdh-record` | Metered retrieval: `famille`, `union`, `acte`, or `individu`, then record ID |
| `archion` | Archive browsing, session/login, OCR, viewing, guarded downloads and budget ledger |
| `matricula` | Parish/register discovery and page retrieval |
| `gro-search` | England/Wales index search: surname and `--year YYYY` |
| `freebmd` | England/Wales queries with known-positive controls before negative results |
| `register-cache` | Address or deposit files into the shared frame cache |
| `register-seek` | Locate a register frame by a supplied year/frame mapping |
| `register-batch` | Batch retrieval with resumable progress and browser exclusion |
| `browser-lock` | Acquire, renew, inspect or release a browser mutex |

There is no dedicated ScotlandsPeople adapter in this package. Scottish indexed
records use FamilySearch. `--self-test` belongs to the original private regression
harness; run `npm test` in this source checkout for distributable tests.

## Consumer configuration

`--project DIRECTORY` or `GENEALOGY_PROJECT_ROOT` selects the project (default:
current working directory). Installed package paths never determine output
locations. A project may supply `genealogy.config.json`:

```json
{
  "gedPath": "data/tree.ged",
  "recordsDir": "records",
  "worklistPath": "records/consistency/worklist.json"
}
```

`GENEALOGY_GED_PATH`, `GENEALOGY_RECORDS_DIR`, and `GENEALOGY_WORKLIST_PATH`
override those values; relative values resolve against the project root.
Unknown keys and malformed configuration are rejected.

| Setting | Meaning |
|---|---|
| `GENEALOGY_BROWSER_STATE_DIR` | Absolute shared lock directory; defaults to `~/.local/state/ged-tools` |
| `GENEALOGY_CDP_ORIGIN` | Shared research Chrome endpoint; defaults to `http://127.0.0.1:9222` |
| `REGISTER_CACHE_DIR` | Absolute shared frame-cache directory; defaults to the main checkout's `.register-cache` |
| `ARCHION_CDP_PORT` | Dedicated browser port; defaults to 9223 |
| `ARCHION_PROFILE_DIR` | Browser profile directory |
| `GENEALOGY_CHROME_BINARY` | Chrome executable for Archion `chrome-up` |
| `ARCHION_ENV_FILE` | Absolute credential-file path; defaults to the main checkout's `.env` |
| `ARCHION_BUDGET_FILE` | Absolute local budget-ledger path; defaults to `.archion-downloads.json` in the main checkout |
| `GENEALOGY_CONTROLS_PATH` | Absolute path to private JSON controls, described below |

All processes driving the same browser must share a lock directory. Projects
migrating from an existing lock system must configure that same location for
both old and new commands. Keep locks and the budget ledger shared across
worktrees. Outside Git, the selected project is treated as its own main root;
`register-cache put` still refuses a destination that Git does not ignore.

Controls contain `freebmd: { query, expected }`, where `query` is a known-positive
search and `expected` is a nonempty array of expected result-field objects.
No real person's control query is shipped. For programmatic `runSearch`, pass
`controlQuery` and `controlExpected` explicitly or use the controls file.
A missing or failed control cannot produce a confirmed negative.

Optional controls are `familysearchProbeArk` (a known-accessible image ARK for
the second session probe) and `familysearchRoot: { pid, gedId }`. They may also
be supplied using `fs-fulltext session --probe-ark` and `fs-audit --root`.
Private controls and captured responses belong in the consuming project.

## Development and privacy

Run `npm test` and `npm run audit:release`. Create a tarball outside the checkout
with `npm pack --pack-destination /path/to/output`. Both checks run before packing.

The library does not anonymize input or captured output. There is no telemetry,
but research commands intentionally send queries to the selected archive.
Keep credentials, cookies, browser profiles, control queries, budgets and
captures out of the tool repository. See [PRIVACY.md](PRIVACY.md).

Releases are published manually. Before publishing, follow the review in
[PRIVACY.md](PRIVACY.md), run `npm pack --pack-destination /path/to/output`,
and inspect the resulting archive. Publish that exact reviewed archive with
`npm publish /path/to/output/rjwalters-ged-tools-VERSION.tgz --access public`.
Create a matching `vVERSION` tag and GitHub release for the reviewed commit.
Never overwrite an existing version with different contents.

Similarity scoring follows the design of
[elliotchance/gedcom](https://github.com/elliotchance/gedcom); its algorithm
provenance is retained in the implementation.
