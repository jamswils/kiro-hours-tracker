# KiroSessionsInspector — build and install targets.
#
#   make build      - release binary only
#   make bundle     - KiroSessionsInspector.app in .build/bundle
#   make install    - copy .app to /Applications and link CLI into /usr/local/bin
#   make uninstall  - remove installed copies
#   make run        - bundle and open the .app
#   make clean      - wipe build artifacts

APP_NAME    := KiroSessionsInspector
BUNDLE_DIR  := .build/bundle
APP_BUNDLE  := $(BUNDLE_DIR)/$(APP_NAME).app
PREFIX      ?= /usr/local
APPS_DIR    ?= /Applications

.PHONY: build bundle install uninstall run clean icon dmg zip dist

icon:
	./scripts/make-icon.sh

build:
	swift build -c release

bundle: icon
	./scripts/make-app-bundle.sh $(BUNDLE_DIR)

dmg: bundle
	./scripts/make-dmg.sh

zip: bundle
	./scripts/make-zip.sh

dist: dmg zip
	@echo "Distributable artifacts in .build/dist/"

install: bundle
	rm -rf "$(APPS_DIR)/$(APP_NAME).app"
	cp -R "$(APP_BUNDLE)" "$(APPS_DIR)/"
	mkdir -p "$(PREFIX)/bin"
	printf '#!/bin/sh\nopen -a "%s/%s.app" "$$@"\n' "$(APPS_DIR)" "$(APP_NAME)" \
		> "$(PREFIX)/bin/kiro-sessions-inspector"
	chmod +x "$(PREFIX)/bin/kiro-sessions-inspector"
	@echo "Installed $(APPS_DIR)/$(APP_NAME).app and $(PREFIX)/bin/kiro-sessions-inspector"

uninstall:
	rm -rf "$(APPS_DIR)/$(APP_NAME).app"
	rm -f "$(PREFIX)/bin/kiro-sessions-inspector"

run: bundle
	open "$(APP_BUNDLE)"

clean:
	rm -rf .build
