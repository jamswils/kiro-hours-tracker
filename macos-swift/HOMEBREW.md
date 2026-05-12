# Installing via Homebrew

Kiro Sessions Inspector is distributed as a Homebrew formula that builds from
source. Installation requires an Xcode (or Command Line Tools) install with
Swift 5.9 or newer.

## Quick install from a tap

Once this repo is published and tapped, a user can install with:

```bash
brew tap jamswils/kiro
brew install --HEAD kiro-sessions-inspector
```

The formula lives in [`Formula/kiro-sessions-inspector.rb`](Formula/kiro-sessions-inspector.rb).

## Install locally without a tap

You can point Homebrew at the formula directly from a clone of this repo:

```bash
brew install --HEAD --build-from-source ./macos-swift/Formula/kiro-sessions-inspector.rb
```

## Install without Homebrew (Makefile)

If you'd rather skip Homebrew entirely:

```bash
cd macos-swift
make install          # builds, bundles, copies to /Applications, drops a CLI launcher
```

Override locations with `PREFIX` and `APPS_DIR`:

```bash
make install PREFIX="$HOME/.local" APPS_DIR="$HOME/Applications"
```

## Setting up your own tap

To publish this as `brew install <you>/kiro/kiro-sessions-inspector`:

1. Create a public GitHub repo named `homebrew-kiro`.
2. Copy `Formula/kiro-sessions-inspector.rb` into `Formula/` of that repo.
3. Update the `homepage` and `head` URLs in the formula to point at your
   fork of the repo.
4. Push the tap repo.
5. Consumers run `brew tap <you>/kiro && brew install --HEAD kiro-sessions-inspector`.

For a tagged release, replace the `head` block in the formula with a `url`
and `sha256` pointing at a release tarball (see the comment in the file).

## Uninstall

```bash
brew uninstall kiro-sessions-inspector
# or, if installed via Makefile:
cd macos-swift && make uninstall
```
