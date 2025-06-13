import { MakerBase, type MakerOptions } from "@electron-forge/maker-base";
import type { ForgePlatform } from "@electron-forge/shared-types";
import { sign, type SignOptions } from "@electron/windows-sign";
import { exec } from "child_process";
import debug from "debug";
import fs from "fs-extra";
import path from "node:path";

const log = debug("electron-forge:maker:msix");

export type MSIXCodesignOptions = Omit<SignOptions, "appDirectory">;

async function* walk(dir: string): AsyncGenerator<string> {
	for await (const d of await fs.opendir(dir)) {
		const entry = path.join(dir, d.name);
		if (d.isDirectory()) {
			yield* walk(entry);
		} else if (d.isFile()) {
			yield entry;
		}
	}
}

const codesign = async (config: MakerMSIXConfig, outPath: string) => {
	if (config.codesign) {
		try {
			if ((await fs.stat(outPath)).isDirectory()) {
				log(`Signing directory ${outPath}`);
				await sign({ ...config.codesign, appDirectory: outPath });
			} else {
				log(`Signing file ${outPath}`);
				await sign({ ...config.codesign, files: [outPath] });
			}
		} catch (error) {
			console.error(
				"Failed to codesign using @electron/windows-sign. Check your config and the output for details!",
				error,
			);
			throw error;
		}

		// Setup signing. If these variables are set, app-builder-lib will actually
		// codesign.
		if (!process.env.CSC_LINK && config.codesign.certificateFile) {
			log(`Setting process.env.CSC_LINK to ${config.codesign.certificateFile}`);
			process.env.CSC_LINK = config.codesign.certificateFile;
		}

		if (!process.env.CSC_KEY_PASSWORD && config.codesign.certificatePassword) {
			log("Setting process.env.CSC_KEY_PASSWORD to the passed password");
			process.env.CSC_KEY_PASSWORD = config.codesign.certificatePassword;
		}
	} else {
		log("Skipping code signing, if you need it set 'config.codesign'");
	}
};

export type MakerMSIXConfig = {
	makeAppXPath?: string;
	codesign?: MSIXCodesignOptions;
};

const makeFileMappingAndFindMainExe = async (
	options: MakerOptions,
	mappingFileName: string,
	rootPath: string,
): Promise<string | undefined> => {
	let mainExe: string | undefined;

	log(`Writing file mapping to ${mappingFileName}`);
	let content = "[Files]\n";
	for await (const fileName of await walk(rootPath)) {
		const relativeFileName =
			`VFS\\UserProgramFiles\\${options.appName}\\` +
			fileName.substring(rootPath.length).replace(/^[\\/]+/, "");
		// Did we fine the executable?
		if (relativeFileName.toLowerCase().endsWith(".exe") && !mainExe) {
			mainExe = relativeFileName;
		}
		content += `"${fileName}" "${relativeFileName}"\n`;
	}

	await fs.writeFile(mappingFileName, content);

	return mainExe;
};

const makeAppManifest = async (manifestFilename: string) => {
	log(`Writing app manifest to ${manifestFilename}`);
	const content = "";

	await fs.writeFile(manifestFilename, content);
};

const makeMSIX = async (
	appManifestPath: string,
	fileMappingPath: string,
	outMSIX: string,
	config: MakerMSIXConfig,
) => {
	const makeAppXPath = config.makeAppXPath ?? "makeappx.exe";
	const commandLine = `"${makeAppXPath}" pack /m "${appManifestPath}" /f ${fileMappingPath} /p "${outMSIX}"`;
	log(`Running ${commandLine}`);

	await exec(commandLine);
	await codesign(config, outMSIX);
};

export default class MakerMSIX extends MakerBase<MakerMSIXConfig> {
	name = "msix";
	defaultPlatforms: ForgePlatform[] = ["win32"];

	isSupportedOnCurrentPlatform(): boolean {
		return process.platform === "win32";
	}

	async make(options: MakerOptions): Promise<string[]> {
		// Copy out files to scratch directory for signing/packaging
		const scratchPath = path.join(options.makeDir, `scratch/`);
		await fs.ensureDir(scratchPath);
		await fs.copy(options.dir, scratchPath);
		await codesign(this.config, scratchPath);

		// Make sure the build dir exists
		const outPath = path.join(
			options.makeDir,
			`${options.appName}-${options.targetArch}-msix/`,
		);
		await fs.ensureDir(outPath);

		//
		const fileMappingPath = path.join(outPath, "filemapping.txt");
		const mainExe = await makeFileMappingAndFindMainExe(
			options,
			fileMappingPath,
			scratchPath,
		);
		if (!mainExe) {
			log("Did not find an executable!");
			throw new Error(
				`No executable found for package in ${options.dir}, is this a packaged electron app?`,
			);
		}

		const appManifestPath = path.join(outPath, "appmanifest.xml");
		await makeAppManifest(appManifestPath);

		const outMSIX = path.join(
			outPath,
			`${options.appName} ${options.packageJSON.version} (${options.targetArch}).msix`,
		);
		await makeMSIX(appManifestPath, fileMappingPath, outMSIX, this.config);

		return [outMSIX];
	}
}
