import { MakerBase, type MakerOptions } from "@electron-forge/maker-base";
import type { ForgePlatform } from "@electron-forge/shared-types";
import fs from "fs-extra";
import path from "node:path";

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

export type MakerMSIXConfig = {
	sign?: undefined;
};

const makeFileMapping = async (mappingFileName: string, rootPath: string) => {
	let content = "[Files]\n";
	for await (const fileName of await walk(rootPath)) {
		const relativeFileName = fileName
			.substring(rootPath.length)
			.replace(/^[\\/]+/, "");
		content += `"${fileName}" "${relativeFileName}"\n`;
	}

	await fs.writeFile(mappingFileName, content);
};

export default class MakerMSIX extends MakerBase<MakerMSIXConfig> {
	name = "msix";
	defaultPlatforms: ForgePlatform[] = ["win32"];

	isSupportedOnCurrentPlatform(): boolean {
		return process.platform === "win32";
	}

	async make({
		dir,
		makeDir,
		appName,
		targetArch,
	}: MakerOptions): Promise<string[]> {
		// Copy out files to scratch directory for signing/packaging
		const scratchPath = path.join(makeDir, `scratch/`);
		await fs.ensureDir(scratchPath);
		await fs.copy(dir, scratchPath);

		const outPath = path.join(makeDir, `${appName}-${targetArch}-msix/`);
		await fs.ensureDir(outPath);

		const fileMappingPath = path.join(outPath, "filemapping.txt");
		await makeFileMapping(fileMappingPath, scratchPath);

		// fs.removeSync(scratchPath);

		return [];
	}
}
