import { AutoUnpackNativesPlugin } from "@electron-forge/plugin-auto-unpack-natives"
import { FusesPlugin } from "@electron-forge/plugin-fuses"
import { WebpackPlugin } from "@electron-forge/plugin-webpack"
import type { ForgeConfig } from "@electron-forge/shared-types"
import { FuseV1Options, FuseVersion } from "@electron/fuses"

import { mainConfig } from "./webpack.main.config"
import { rendererConfig } from "./webpack.renderer.config"

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    icon: "assets/appicon.png",
    protocols: [{ name: "App Scheme", schemes: ["my-app"] }],
  },
  rebuildConfig: {},
  makers: [
    {
      name: "@felixrieseberg/electron-forge-maker-nsis",
      config: {
        getAppBuilderConfig: () => {
          return {
            artifactName: "Ma App Installer Setup.exe",
            win: {
              forceCodeSigning: false,
            },
          }
        },
      },
    },
    {
      name: "@jasonscheirer/electron-forge-maker-msix",
      config: {
        internalAppID: "com.jasonscheirer.myapp",
        appIcon: "assets/appicon.png",
        wallpaperIcon: "assets/wallpaper.png",
        codesign: {
          certificateFile: "c:\\Users\\JasonScheirer\\certificate.pfx",
        },
        baseDownloadURL: "https://jasonscheirer.com/apps/",
      },
    },
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
