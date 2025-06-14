import { MakerBase, type MakerOptions } from "@electron-forge/maker-base"
import type { ForgePlatform } from "@electron-forge/shared-types"
import { sign, type SignOptions } from "@electron/windows-sign"
import { exec } from "node:child_process"
import debug from "debug"
import fs from "fs-extra"
import path from "node:path"
import Sharp from "sharp"

const log = debug("electron-forge:maker:msix")

export type MSIXCodesignOptions = Omit<SignOptions, "appDirectory">

type PathInManifest = string
type PathOnDisk = string
type FileMapping = Record<PathInManifest, PathOnDisk>

type ImageDimensions = { h: number; w: number }
const REQUIRED_APPX_DIMENSIONS: ImageDimensions[] = [
  { w: 150, h: 150 },
  { w: 44, h: 44 },
  { w: 310, h: 150 },
  { w: 310, h: 310 },
  { w: 71, h: 71 },
]
const REQUIRED_APPX_SCALES: number[] = [100, 125, 150, 200, 400]

export type MakerMSIXConfig = {
  appIcon: string
  internalAppID?: string
  wallpaperIcon?: string
  makeAppXPath?: string
  codesign?: MSIXCodesignOptions
  protocols?: string[]
}

async function* walk(dir: string): AsyncGenerator<string> {
  for await (const d of await fs.opendir(dir)) {
    const entry = path.join(dir, d.name)
    if (d.isDirectory()) {
      yield* walk(entry)
    } else if (d.isFile()) {
      yield entry
    }
  }
}

const codesign = async (config: MakerMSIXConfig, outPath: string) => {
  if (config.codesign) {
    try {
      if ((await fs.stat(outPath)).isDirectory()) {
        log(`Signing directory ${outPath}`)
        await sign({ ...config.codesign, appDirectory: outPath })
      } else {
        log(`Signing file ${outPath}`)
        await sign({ ...config.codesign, files: [outPath] })
      }
    } catch (error) {
      console.error(
        "Failed to codesign using @electron/windows-sign. Check your config and the output for details!",
        error
      )
      throw error
    }

    // Setup signing. If these variables are set, app-builder-lib will actually
    // codesign.
    if (!process.env.CSC_LINK && config.codesign.certificateFile) {
      log(`Setting process.env.CSC_LINK to ${config.codesign.certificateFile}`)
      process.env.CSC_LINK = config.codesign.certificateFile
    }

    if (!process.env.CSC_KEY_PASSWORD && config.codesign.certificatePassword) {
      log("Setting process.env.CSC_KEY_PASSWORD to the passed password")
      process.env.CSC_KEY_PASSWORD = config.codesign.certificatePassword
    }
  } else {
    log("Skipping code signing, if you need it set 'config.codesign'")
  }
}

const inventoryInstallFilesForMapping = async (
  rootPath: string,
  options: MakerOptions
): Promise<FileMapping> => {
  const fileMapping: FileMapping = {}

  for await (const fileName of walk(rootPath)) {
    const relativeFileName: PathInManifest =
      `VFS\\UserProgramFiles\\${options.appName}\\` +
      fileName.substring(rootPath.length).replace(/^[\\/]+/, "")

    fileMapping[relativeFileName] = fileName
  }

  return fileMapping
}

const makeAppXImages = async (
  appID: string,
  outPath: string,
  config: MakerMSIXConfig
): Promise<FileMapping> => {
  const fileMapping: FileMapping = {}
  const assetPath = path.join(outPath, "image-assets")
  await fs.ensureDir(assetPath)
  for (const scale of REQUIRED_APPX_SCALES) {
    const scaleMultiplier = scale / 100.0
    for (const dimensions of REQUIRED_APPX_DIMENSIONS) {
      const { w, h } = dimensions

      const imageName = `${appID}-${w}x${h}.scale-${scale}.png`
      const pathOnDisk = path.join(path.join(assetPath, imageName))
      const pathinManifest = path.join("ASSETS", imageName)

      const image = Sharp(config.appIcon)
      // Small touch: superimpose the app icon on a background for banner-sized images
      if ((h >= 300 || w >= 300) && config.wallpaperIcon) {
        const bgimage = Sharp(config.wallpaperIcon).resize(w, h, {
          fit: "contain",
        })
        const overlayicon = await image
          .resize(w * 0.85, h * 0.85, { fit: "inside" })
          .toBuffer()
        await bgimage
          .composite([{ input: overlayicon, gravity: "center" }])
          .toFile(pathOnDisk)
      } else {
        await image
          .resize(w * scaleMultiplier, h * scaleMultiplier, { fit: "contain" })
          .toFile(pathOnDisk)
      }

      fileMapping[pathinManifest] = pathOnDisk
    }
  }

  return fileMapping
}

const makeAppManifest = async (
  outPath: string,
  config: MakerMSIXConfig
): Promise<FileMapping> => {
  await fs.ensureDir(outPath)

  const outFilePath = path.join(outPath, "AppxManifest.xml")

  return { "AppxManifest.xml": outFilePath }
}

const writeMappingFile = async (
  fileMapping: FileMapping,
  mappingFilename: string
): Promise<void> => {
  log(`Writing file mapping to ${fileMapping}`)
  const contentLines = ["[Files]"]

  for (const [inManifest, onDisk] of Object.entries(fileMapping)) {
    contentLines.push(`"${onDisk}" "${inManifest}"`)
  }

  // Lol dos
  await fs.writeFile(mappingFilename, contentLines.join("\r\n"))
}

const makeMSIX = async (
  appManifestPath: string,
  fileMappingPath: string,
  outMSIX: string,
  config: MakerMSIXConfig
) => {
  const makeAppXPath =
    config.makeAppXPath ??
    "C:\\Program Files (x86)\\Windows Kits\\10\\App Certification Kit\\makeappx.exe"
  const commandLine = `"${makeAppXPath}" pack /m "${appManifestPath}" /f ${fileMappingPath} /p "${outMSIX}"`
  log(`Running ${commandLine}`)

  exec(commandLine)
  await codesign(config, outMSIX)
}

export default class MakerMSIX extends MakerBase<MakerMSIXConfig> {
  name = "msix"
  defaultPlatforms: ForgePlatform[] = ["win32"]

  isSupportedOnCurrentPlatform(): boolean {
    return process.platform === "win32"
  }

  async make(options: MakerOptions): Promise<string[]> {
    const appID =
      this.config.internalAppID ??
      options.appName
        .toUpperCase()
        .replace(/[^A-Z]/, "")
        .slice(0, 10)

    // Copy out files to scratch directory for signing/packaging
    const scratchPath = path.join(options.makeDir, `scratch/`)
    await fs.ensureDir(scratchPath)
    await fs.copy(options.dir, scratchPath)
    await codesign(this.config, scratchPath)

    // Make sure the build dir exists
    const outPath = path.join(
      options.makeDir,
      `${options.appName}-${options.targetArch}-msix/`
    )
    await fs.ensureDir(outPath)

    // Find all the files to be installed
    const installMapping = await inventoryInstallFilesForMapping(
      scratchPath,
      options
    )

    // Generate images for various tile sizes
    const imageAssetMapping = await makeAppXImages(
      appID,
      options.makeDir,
      this.config
    )

    // Actual AppxManifest.xml, the orchestration layer
    const appManifestPath = path.join(outPath, "appmanifest.xml")
    const appManifestMapping: FileMapping = await makeAppManifest(
      outPath,
      this.config
    )

    // Write file mapping
    // Combine all the files we need to install into a single filemapping
    const manifestMapping = Object.assign(
      {},
      appManifestMapping,
      installMapping,
      imageAssetMapping
    )
    const fileMappingPath = path.join(outPath, "filemapping.txt")
    writeMappingFile(manifestMapping, fileMappingPath)

    const outMSIX = path.join(
      outPath,
      `${options.appName} ${options.packageJSON.version} (${options.targetArch}).msix`
    )
    await makeMSIX(appManifestPath, fileMappingPath, outMSIX, this.config)

    return [outMSIX]
  }
}
