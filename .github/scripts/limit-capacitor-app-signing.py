#!/usr/bin/env python3
"""Apply the App Store profile to the Capacitor App target only.

xcodebuild command-line settings are inherited by every target. Swift package
libraries such as IONCameraLib cannot use an app provisioning profile, so the
archive fails when the profile is passed on the command line.
"""

import os
import re
import sys
from pathlib import Path


def main() -> None:
    pbx_path = Path("apps/capacitor/ios/App/App.xcodeproj/project.pbxproj")
    if not pbx_path.is_file():
        sys.exit(f"Missing {pbx_path}")

    profile = os.environ["APPLE_PROVISIONING_PROFILE_SPECIFIER"]
    team = os.environ["DEVELOPMENT_TEAM"]
    bundle = os.environ["BUNDLE_IDENTIFIER"]
    if any(char in profile for char in '"\n\\'):
        sys.exit("Provisioning profile name contains unsupported characters")

    text = pbx_path.read_text()
    parts = text.split("isa = XCBuildConfiguration;")
    rebuilt = [parts[0]]
    patched = 0
    style_line = "\t\t\t\tCODE_SIGN_STYLE = Automatic;"
    for part in parts[1:]:
        is_app_release = (
            "ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;" in part
            and "\n\t\t\tname = Release;" in part
            and "DEBUG" not in part.split("name = Release;", 1)[0]
        )
        if is_app_release:
            if style_line not in part:
                sys.exit("App Release configuration is not using automatic signing")
            part = re.sub(
                r"\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = [^;]+;",
                f"\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = {bundle};",
                part,
                count=1,
            )
            part = part.replace(
                style_line,
                "\n".join(
                    [
                        "\t\t\t\tCODE_SIGN_STYLE = Manual;",
                        '\t\t\t\tCODE_SIGN_IDENTITY = "Apple Distribution";',
                        f"\t\t\t\tDEVELOPMENT_TEAM = {team};",
                        f'\t\t\t\tPROVISIONING_PROFILE_SPECIFIER = "{profile}";',
                    ]
                ),
                1,
            )
            patched += 1
        rebuilt.append(part)

    if patched != 1:
        sys.exit(f"Expected to patch 1 App Release configuration, patched {patched}")

    updated = "isa = XCBuildConfiguration;".join(rebuilt)
    if updated.count(profile) != 1:
        sys.exit("App Store profile was not written only once")
    pbx_path.write_text(updated)
    print(f"Limited App Store signing to the App target with profile {profile}")


if __name__ == "__main__":
    main()
