import { MakerZIP } from "@electron-forge/maker-zip"
import { AutoUnpackNativesPlugin } from "@electron-forge/plugin-auto-unpack-natives"
import { FusesPlugin } from "@electron-forge/plugin-fuses"
import { WebpackPlugin } from "@electron-forge/plugin-webpack"
import type { ForgeConfig } from "@electron-forge/shared-types"
import { FuseV1Options, FuseVersion } from "@electron/fuses"

import MSIXMaker from "./msixMaker"
import { mainConfig } from "./webpack.main.config"
import { rendererConfig } from "./webpack.renderer.config"

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    icon: "assets/appicon.png",
  },
  rebuildConfig: {},
  makers: [
    {
      name: "@felixrieseberg/electron-forge-maker-nsis",
      config: {
        getAppBuilderConfig: () => {
          return {
            artifactName: "App Setup.exe",
            win: {
              forceCodeSigning: false,
            },
          }
        },
      },
    },
    new MakerZIP({}),
    new MSIXMaker({
      appIcon: "assets/appicon.png",
      wallpaperIcon: "assets/wallpaper.png",
      codesign: {
        certificateFile: "c:\\Users\\JasonScheirer\\certificate.pfx",
      },
      baseDownloadURL: "https://jasonscheirer.com/apps/",
    }),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new WebpackPlugin({
      mainConfig,
      renderer: {
        config: rendererConfig,
        entryPoints: [
          {
            html: "./src/index.html",
            js: "./src/renderer.ts",
            name: "main_window",
            preload: {
              js: "./src/preload.ts",
            },
          },
        ],
      },
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
}

export default config
