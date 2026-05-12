class KiroSessionsInspector < Formula
  desc "Native macOS inspector for Kiro IDE session data"
  homepage "https://github.com/jamswils/kiro-hours-tracker"
  license "MIT-0"
  head "https://github.com/jamswils/kiro-hours-tracker.git", branch: "main"

  # For a tagged release, replace `head` with:
  #   url "https://github.com/jamswils/kiro-hours-tracker/archive/refs/tags/v0.1.0.tar.gz"
  #   sha256 "<shasum of the tarball>"
  #   version "0.1.0"

  depends_on :macos
  depends_on xcode: ["15.0", :build]

  def install
    cd "macos-swift" do
      system "./scripts/make-app-bundle.sh", buildpath/"bundle"

      prefix.install "bundle/KiroSessionsInspector.app"
      bin.write_exec_script "#{prefix}/KiroSessionsInspector.app/Contents/MacOS/KiroSessionsInspector"
      mv bin/"KiroSessionsInspector", bin/"kiro-sessions-inspector"
    end
  end

  def caveats
    <<~EOS
      The app was installed to:
        #{prefix}/KiroSessionsInspector.app

      Launch it from the command line:
        kiro-sessions-inspector

      Or drag the bundle into /Applications:
        cp -R #{prefix}/KiroSessionsInspector.app /Applications/
    EOS
  end

  test do
    assert_predicate prefix/"KiroSessionsInspector.app/Contents/MacOS/KiroSessionsInspector", :executable?
  end
end
