import { MakerBase, type MakerOptions } from "@electron-forge/maker-base"
import type { ForgePlatform } from "@electron-forge/shared-types"
import { sign, type SignOptions } from "@electron/windows-sign"
import type { HASHES } from "@electron/windows-sign/dist/cjs/types"
import debug from "debug"
import fs from "fs-extra"
import { spawn } from "node:child_process"
import path from "node:path"
import Sharp from "sharp"

export type MakerMSIXConfig = {
  appIcon: string
  publisher?: string
  internalAppID?: string
  appDescription?: string
  wallpaperIcon?: string
  makeAppXPath?: string
  makePriPath?: string
  sigCheckPath?: string
  codesign?: MSIXCodesignOptions
  protocols?: string[]
}

const log = debug("electron-forge:maker:msix")

const run = async (
  executable: string,
  args: Array<string>,
  neverFail = false
) => {
  return new Promise<string>((resolve, reject) => {
    const proc = spawn(executable, args, {})
    log(`Running ${JSON.stringify([executable].concat(args))}`)

    let runningStdout = ""
    let collectedStdoutLogForReturn = ""
    proc.stdout.on("data", (data) => {
      collectedStdoutLogForReturn += data
      runningStdout += data

      if (runningStdout.includes("\n")) {
        const logLines = runningStdout.split("\n")
        while (logLines.length > 1) {
          log(`stdout: ${logLines.shift()?.trimEnd()}`)
        }
        if (logLines.length > 0) {
          runningStdout = logLines[0]
        }
      }
    })

    let runningStderr = ""
    proc.stderr.on("data", (data) => {
      runningStderr += data

      if (runningStderr.includes("\n")) {
        const logLines = runningStderr.split("\n")
        while (logLines.length > 1) {
          log(`stderr: ${logLines.shift()?.trimEnd()}`)
        }
        if (logLines.length > 0) {
          runningStderr = logLines[0]
        }
      }
    })

    proc.on("exit", (code) => {
      runningStdout
        .split("\n")
        .forEach((line) => log(`stdout: ${line.trimEnd()}`))
      runningStderr
        .split("\n")
        .forEach((line) => log(`stderr: ${line.trimEnd()}`))
      if (code !== 0) {
        if (neverFail) {
          log(`warning: ${executable} returned: ${code}`)
        } else {
          return reject(new Error(`Running ${executable} returned: ${code}.`))
        }
      }
      return resolve(collectedStdoutLogForReturn)
    })

    proc.stdin.end()
  })
}

export type MSIXCodesignOptions = Omit<
  Omit<SignOptions, "appDirectory">,
  "hashes"
>

type PathInManifest = string
type PathOnDisk = string
type FileMapping = Record<PathInManifest, PathOnDisk>

type ImageDimensions = { h: number; w: number; specialName?: string }
const REQUIRED_APPX_DIMENSIONS: ImageDimensions[] = [
  { w: 150, h: 150 },
  { w: 44, h: 44 },
  { w: 310, h: 150 },
  { w: 310, h: 310 },
  { w: 71, h: 71 },
  { w: 50, h: 50, specialName: "StoreLogo" },
]
const REQUIRED_APPX_SCALES: number[] = [100, 125, 150, 200, 400]

export type MSIXAppManifestMetadata = {
  appID: string
  appName: string
  appDescription: string
  publisher: string
  version: string
  executable: string
  architecture: string
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
        await sign({
          ...config.codesign,
          appDirectory: outPath,
          hashes: ["sha256" as HASHES],
        })
      } else {
        log(`Signing file ${outPath}`)
        await sign({
          ...config.codesign,
          files: [outPath],
          hashes: ["sha256" as HASHES],
        })
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
): Promise<[string, FileMapping]> => {
  const fileMapping: FileMapping = {}

  let executable: string | undefined
  for await (const fileName of walk(rootPath)) {
    const relativeFileName: PathInManifest =
      `VFS\\UserProgramFiles\\${options.appName}\\` +
      fileName.substring(rootPath.length).replace(/^[\\/]+/, "")

    if (!executable && relativeFileName.toLocaleLowerCase().endsWith(".exe")) {
      executable = relativeFileName
    }

    fileMapping[relativeFileName] = fileName
  }

  if (!executable) {
    throw new Error(`No executable file found in ${rootPath}`)
  }

  return [executable, fileMapping]
}

const makeAppXImages = async (
  appID: string,
  outPath: string,
  config: MakerMSIXConfig
): Promise<FileMapping> => {
  const fileMapping: FileMapping = {}
  const assetPath = path.join(outPath, "ASSETS")
  await fs.ensureDir(assetPath)
  for (const scale of REQUIRED_APPX_SCALES) {
    const scaleMultiplier = scale / 100.0
    for (const dimensions of REQUIRED_APPX_DIMENSIONS) {
      const { w, h } = dimensions

      const baseName = dimensions.specialName ?? `${appID}-${w}x${h}Logo`

      const imageName = `${baseName}.png`
      const pathinManifestWithoutScale = path.join("ASSETS", imageName)
      const pathOnDiskWithoutScale = path.join(path.join(assetPath, imageName))

      const imageNamewithScale = `${baseName}.scale-${scale}.png`
      const pathOnDiskWithScale = path.join(
        path.join(assetPath, imageNamewithScale)
      )
      const pathinManifestwithScale = path.join("ASSETS", imageNamewithScale)

      const image = Sharp(config.appIcon)
      // Small touch: superimpose the app icon on a background for banner-sized images
      if ((h >= 300 || w >= 300) && config.wallpaperIcon) {
        const bgimage = Sharp(config.wallpaperIcon).resize(w, h, {
          fit: "contain",
        })
        const overlayicon = await image
          .resize(Math.trunc(w * 0.85), Math.trunc(h * 0.85), { fit: "inside" })
          .toBuffer()
        await bgimage
          .composite([{ input: overlayicon, gravity: "center" }])
          .toFile(pathOnDiskWithScale)
      } else {
        await image
          .resize(
            Math.trunc(w * scaleMultiplier),
            Math.trunc(h * scaleMultiplier),
            { fit: "contain" }
          )
          .toFile(pathOnDiskWithScale)
      }

      if (scale === 100) {
        await fs.copyFile(pathOnDiskWithScale, pathOnDiskWithoutScale)
        fileMapping[pathinManifestWithoutScale] = pathOnDiskWithoutScale
      }
      fileMapping[pathinManifestwithScale] = pathOnDiskWithScale
    }
  }

  return fileMapping
}

const makePRI = async (
  outPath: string,
  config: MakerMSIXConfig
): Promise<FileMapping> => {
  const makePRIPath =
    config.makePriPath ??
    "C:\\Program Files (x86)\\Windows Kits\\10\\bin\\10.0.26100.0\\x86\\makepri.exe"

  await run(makePRIPath, ["/pr", outPath])
  return { "resources.pri": path.join(outPath, "resources.pri") }
}

const getPublisher = async (
  installMapping: FileMapping,
  config: MakerMSIXConfig
): Promise<string> => {
  const exes = Object.values(installMapping).filter((f) =>
    f.toLowerCase().endsWith(".exe")
  )
  if (exes.length > 0) {
    const stdout = await run(
      config.sigCheckPath ?? "sigcheck.exe",
      ["-accepteula", exes[0]],
      true
    )
    const publisherRE = /\r\n[ \t]+Publisher:[ \t]+(?<publisher>.+?)\r\n/
    const foundPublisher = stdout.match(publisherRE)?.groups?.publisher
    if (foundPublisher) {
      return foundPublisher
    } else {
      throw new Error(
        `Could not determine publisher: ${exes[0]} is not signed.`
      )
    }
  } else {
    throw new Error("Could not determine publisher: nothing signed")
  }
}

const makeAppManifestXML = ({
  appID,
  appName,
  architecture,
  appDescription,
  executable,
  publisher,
  version,
  protocols,
}: MSIXAppManifestMetadata): string => {
  let extensions = ""

  if (protocols) {
    for (const protocol of protocols) {
      extensions += `<uap3:Extension Category="windows.protocol">
                    <uap3:Protocol Name="${protocol}" Parameters="&quot;%1&quot;">
                        <uap:DisplayName>${protocol}</uap:DisplayName>
                    </uap3:Protocol>
                </uap3:Extension>`
    }
  }

  return `
<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
    xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
    xmlns:uap3="http://schemas.microsoft.com/appx/manifest/uap/windows10/3"
    xmlns:uap10="http://schemas.microsoft.com/appx/manifest/uap/windows10/10"
    xmlns:desktop7="http://schemas.microsoft.com/appx/manifest/desktop/windows10/7"
    xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
    IgnorableNamespaces="uap uap3 uap10 desktop7 rescap">
    <Identity Name="${publisher}" Publisher="${
    publisher.startsWith("CN=") ? publisher : `CN=${publisher}`
  }" Version="${version}" ProcessorArchitecture="${architecture}" />
    <Properties>
        <DisplayName>${appName}</DisplayName>
        <PublisherDisplayName>${appName}</PublisherDisplayName>
        <Description>${appDescription}</Description>
        <Logo>ASSETS\\StoreLogo.png</Logo>
        <uap10:PackageIntegrity>
            <uap10:Content Enforcement="on" />
        </uap10:PackageIntegrity>
    </Properties>
    <Resources>
        <Resource Language="en-us" />
    </Resources>
    <Dependencies>
        <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.17763.0"
            MaxVersionTested="10.0.22000.1" />
        <PackageDependency Name="Microsoft.WindowsAppRuntime.1.4" MinVersion="4000.1010.1349.0"
            Publisher="CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US" />
    </Dependencies>
    <Capabilities>
        <rescap:Capability Name="runFullTrust" />
    </Capabilities>
    <Applications>
        <Application Id="${appID}" Executable="${executable}"
            EntryPoint="Windows.FullTrustApplication">
            <uap:VisualElements BackgroundColor="transparent" DisplayName="Notion"
                Square150x150Logo="ASSETS\\${appID}-150x150Logo.png"
                Square44x44Logo="ASSETS\\${appID}-44x44Logo.png" Description="Notion">
                <uap:DefaultTile Wide310x150Logo="ASSETS\\${appID}-310x150Logo.png"
                    Square310x310Logo="ASSETS\\${appID}-310x310Logo.png"
                    Square71x71Logo="ASSETS\\${appID}-71x71Logo.png" />
            </uap:VisualElements>
            <Extensions>
                ${extensions}
            </Extensions>
        </Application>
    </Applications>
</Package>
	`.trim()
}

const makeAppManifest = async (
  outPath: string,
  appID: string,
  version: string,
  executable: string,
  config: MakerMSIXConfig & Required<Pick<MakerMSIXConfig, "publisher">>,
  options: MakerOptions
): Promise<FileMapping> => {
  await fs.ensureDir(outPath)

  const outFilePath = path.join(outPath, "AppxManifest.xml")

  const manifestData: MSIXAppManifestMetadata = {
    appID,
    appName: options.appName,
    appDescription: config.appDescription ?? options.appName,
    executable,
    architecture: options.targetArch,
    version: version
      .split(".")
      .concat(["0", "0", "0", "0"])
      .slice(0, 4)
      .join("."),
    publisher: config.publisher,
    protocols: config.protocols,
  }

  const manifestXML = makeAppManifestXML(manifestData)

  fs.writeFile(outFilePath, manifestXML)

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
  fileMappingPath: string,
  outMSIX: string,
  config: MakerMSIXConfig
) => {
  const makeAppXPath =
    config.makeAppXPath ??
    "C:\\Program Files (x86)\\Windows Kits\\10\\App Certification Kit\\makeappx.exe"

  if ((await fs.stat(outMSIX)).isFile()) {
    log(`${outMSIX} already exists; making new one`)
    await fs.unlink(outMSIX)
  }

  await run(makeAppXPath, ["pack", "/f", fileMappingPath, "/p", outMSIX])
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
    const scratchPath = path.join(options.makeDir, "msix/build/")

    const programFilesPath = path.join(scratchPath, "VFS\\UserProgramFiles")
    await fs.ensureDir(programFilesPath)
    await fs.copy(options.dir, programFilesPath)
    await codesign(this.config, programFilesPath)

    // Make sure the build dir exists
    const outPath = path.join(
      options.makeDir,
      `${options.appName}-${options.targetArch}-msix/`
    )
    await fs.ensureDir(outPath)

    // Find all the files to be installed
    const [executable, installMapping] = await inventoryInstallFilesForMapping(
      scratchPath,
      options
    )

    // Generate images for various tile sizes
    const imageAssetMapping = await makeAppXImages(
      appID,
      scratchPath,
      this.config
    )

    // Actual AppxManifest.xml, the orchestration layer

    // Courtesy: if publisher is not set, pull from signatured exe
    let publisher: string
    if (this.config.publisher) {
      publisher = this.config.publisher
    } else {
      publisher = await getPublisher(installMapping, this.config)
    }

    const appManifestMapping: FileMapping = await makeAppManifest(
      scratchPath,
      appID,
      options.packageJSON.version,
      executable,
      {
        ...this.config,
        publisher,
      },
      options
    )

    const priFileMapping = makePRI(scratchPath, this.config)

    // Write file mapping
    // Combine all the files we need to install into a single filemapping
    const manifestMapping = Object.assign(
      {},
      appManifestMapping,
      installMapping,
      imageAssetMapping,
      priFileMapping
    )
    const fileMappingFilenameOnDisk = path.join(scratchPath, "filemapping.txt")
    writeMappingFile(manifestMapping, fileMappingFilenameOnDisk)

    const outMSIX = path.join(
      outPath,
      `${options.appName} ${options.packageJSON.version} (${options.targetArch}).msix`
    )
    await makeMSIX(fileMappingFilenameOnDisk, outMSIX, this.config)

    return [outMSIX]
  }
}
