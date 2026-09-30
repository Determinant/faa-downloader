import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
    TREEVIEW_VENDOR_JS_DST,
    TREEVIEW_VENDOR_CSS_DST
} from './config.ts';
import { buildSinglePartFarXmlByIndex, parseXml, stripXmlDeclaration } from './xml-transform.ts';
import {
    extractPartEntries,
    extractNavigationParts,
    extractSearchEntries,
    seqnumIdFromSectno
} from './xml-index.ts';
import { addPwaMetadata, writeFarPwaFiles } from './pwa.ts';
import { isStrictChildPath, toPosixPath, writeFileAtomic } from './fs-utils.ts';
import {
    ensureTreeViewVendorAssets,
    readMiniSearchVendorAsset,
    preparePartHtmlForSplitShell
} from './site.ts';
import { buildSplitIndexHtml } from './site-shell.ts';

const execFileAsync = promisify(execFile);
const generationName = () => `generation-${randomUUID()}`;

async function refreshFlatPartLinks(directory, generationDirectory, parts) {
    const filenames = new Set();
    for (const part of parts) {
        const filename = `${part.basename}.html`;
        const alias = path.join(directory, filename);
        const temporary = path.join(directory, `.${filename}.next-${randomUUID()}`);
        filenames.add(filename);
        try {
            await fs.link(path.join(generationDirectory, filename), temporary);
            await fs.rename(temporary, alias);
        } finally {
            await fs.rm(temporary, { force: true });
        }
    }
    return filenames;
}

async function pruneObsoleteFlatPartPages(directory, currentPages) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (entry.isFile() && /^part-[a-z0-9._-]+\.html$/.test(entry.name) && !currentPages.has(entry.name)) {
            await fs.rm(path.join(directory, entry.name));
        }
    }
}

async function renderXmlToHtml({ xslPath, xmlPath, htmlPath }) {
    const { stdout } = await execFileAsync('xsltproc', [xslPath, xmlPath], {
        encoding: 'utf8',
        maxBuffer: 128 * 1024 * 1024
    });
    await writeFileAtomic(htmlPath, stdout, 'utf8');
}

async function generateSplitPartSite({ farXml, htmlPath, xslPath, title, chapter, sourceDescription, scopeDescription, partsDirArg }) {
    const htmlDir = path.dirname(htmlPath);
    const baseName = path.basename(htmlPath, path.extname(htmlPath));
    const outputDir = path.resolve(htmlDir);
    const defaultPartsDir = path.join(outputDir, `${baseName}-parts`);
    const configuredPartsDir = partsDirArg ? path.resolve(partsDirArg) : defaultPartsDir;
    if (!isStrictChildPath(outputDir, configuredPartsDir)) {
        throw new Error(`--parts-dir must be a child directory of the HTML output directory: ${outputDir}`);
    }

    const finalPartsDir = configuredPartsDir;
    const currentGeneration = generationName();
    const generationDir = path.join(finalPartsDir, currentGeneration);
    const partsDir = await fs.mkdtemp(
        path.join(path.dirname(configuredPartsDir), `.${baseName}-parts-build-`)
    );
    const partsDirName = toPosixPath(path.relative(outputDir, finalPartsDir));
    const generationHref = toPosixPath(path.relative(outputDir, generationDir));
    const vendorRelativeRoot = toPosixPath(path.relative(generationDir, outputDir));
    const splitVendorHref = `${vendorRelativeRoot ? `${vendorRelativeRoot}/` : ''}vendor`;

    try {
        await ensureTreeViewVendorAssets(outputDir);
        const searchVendorJs = await readMiniSearchVendorAsset();
        // Parse the normalized FAR once for all index/navigation/search data.
        // Part rendering still reparses each isolated part below by design.
        const farDoc = parseXml(farXml);
        const entries = extractPartEntries(farDoc);
        const navParts = extractNavigationParts(farDoc, entries);
        const buildNonce = String(Date.now());
        if (entries.length === 0) throw new Error('No PART nodes found in FAR XML; cannot split by part.');

        const publicParts = [];
        for (const entry of entries) {
            const partXml = buildSinglePartFarXmlByIndex(farXml, entry.index);
            const htmlFileName = `${entry.basename}.html`;
            const xmlOut = path.join(partsDir, `.tmp-${entry.basename}.xml`);
            const htmlOut = path.join(partsDir, htmlFileName);
            const href = `${generationHref}/${htmlFileName}?v=${buildNonce}`;

            await writeFileAtomic(xmlOut, stripXmlDeclaration(partXml), 'utf8');
            await renderXmlToHtml({ xslPath, xmlPath: xmlOut, htmlPath: htmlOut });
            await fs.rm(xmlOut, { force: true });
            const renderedHtml = await fs.readFile(htmlOut, 'utf8');
            const preparedSplitHtml = preparePartHtmlForSplitShell(renderedHtml, splitVendorHref);
            await writeFileAtomic(htmlOut, preparedSplitHtml, 'utf8');
            publicParts.push({ ...entry, href });
        }

        // Publish a complete generation before switching the shell. The old
        // shell keeps its pages until the new one has been committed.
        await fs.chmod(partsDir, 0o755);
        await fs.mkdir(finalPartsDir, { recursive: true });
        await fs.rename(partsDir, generationDir);

        const hrefByIndex = new Map(publicParts.map(part => [part.index, part.href]));
        const navWithHrefs = navParts.map(part => ({
            ...part,
            href: hrefByIndex.get(part.index) || `${generationHref}/${part.basename}.html?v=${buildNonce}`
        }));
        const renderedScopeDescription = `${scopeDescription}; parts ${publicParts.map(part => part.partNumber).join(', ')}`;
        const searchEntries = extractSearchEntries(farDoc).flatMap(entry => {
            const part = publicParts[entry.partIndex];
            if (!part) return [];
            return [{
                target: `${part.href}#seqnum${seqnumIdFromSectno(entry.sectno)}`,
                sectno: entry.sectno,
                subject: entry.subject,
                partHeading: entry.partHeading || part.heading || part.ear,
                subpart: entry.subpart,
                subjectGroup: entry.subjectGroup,
                text: entry.text
            }];
        });
        await fs.rm(path.join(htmlDir, 'far-search.json'), { force: true });

        const defaultTarget = publicParts[0].href;
        const indexHtml = buildSplitIndexHtml({ title: String(title), chapter: String(chapter), sourceDescription, scopeDescription: renderedScopeDescription, parts: navWithHrefs, defaultSrc: defaultTarget, searchEntries, searchVendorJs });
        const pwaPartFiles = [
            ...publicParts.map(part => path.join(generationDir, `${part.basename}.html`)),
            path.join(outputDir, TREEVIEW_VENDOR_JS_DST),
            path.join(outputDir, TREEVIEW_VENDOR_CSS_DST)
        ];
        const pwa = await writeFarPwaFiles({ htmlDir, shellFileName: path.basename(htmlPath), partFiles: pwaPartFiles, buildVersion: buildNonce });
        await writeFileAtomic(htmlPath, addPwaMetadata(indexHtml, pwa), 'utf8');
        // Keep direct part URLs working for existing bookmarks and old shells.
        const currentPages = await refreshFlatPartLinks(finalPartsDir, generationDir, publicParts);
        await pruneObsoleteFlatPartPages(finalPartsDir, currentPages);

        return { partsDirName, partsDir: finalPartsDir, partCount: publicParts.length };
    } finally {
        // A failed shell write may leave an updated service worker referring to
        // the new pages. Keep any published generation until a later success.
        await fs.rm(partsDir, { recursive: true, force: true }).catch(() => {});
    }
}

export { generateSplitPartSite, renderXmlToHtml };
