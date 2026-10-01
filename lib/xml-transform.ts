import { DOMParser, XMLSerializer, type Document, type Element } from '@xmldom/xmldom';
import xpath from 'xpath';
import { KEEP_PART_NUMBERS } from './config.ts';
import { escapeRegExp, getElementChildren, normalizeWhitespace } from './xml-utils.ts';
import { normalizeSectionParagraphStructure } from './xml-paragraphs.ts';

const xmlParser = new DOMParser({
    onError(level, message) {
        if (level !== 'warning') {
            throw new Error(`Invalid XML: ${message}`);
        }
    }
});
const xmlSerializer = new XMLSerializer();

function parseXml(xml) {
    if (!String(xml || '').trim()) {
        throw new Error('Cannot parse empty XML input');
    }
    return xmlParser.parseFromString(xml, 'application/xml');
}

function serializeXml(doc) {
    return xmlSerializer.serializeToString(doc);
}
function pruneEmptyContainers(doc) {
    const containers = [
        xpath.select('//DIV4[@TYPE="SUBCHAP"]', doc),
        xpath.select('//DIV3[@TYPE="CHAPTER"]', doc)
    ];
    for (const nodes of containers) {
        for (const node of nodes) {
            const partsInside = xpath.select('.//DIV5[@TYPE="PART"]', node);
            if (partsInside.length === 0) {
                node.parentNode.removeChild(node);
            }
        }
    }
}

function filterByVolumes(xml, volumeSet) {
    const doc = parseXml(xml);
    const parts = xpath.select('//DIV5[@TYPE="PART"]', doc);

    for (const part of parts) {
        const vol = (part.getAttribute('VOLUME') || '').trim();
        if (!volumeSet.has(vol)) {
            part.parentNode.removeChild(part);
        }
    }

    pruneEmptyContainers(doc);
    return serializeXml(doc);
}

function filterByKeepParts(xml) {
    const doc = parseXml(xml);
    const parts = xpath.select('//DIV5[@TYPE="PART"]', doc);

    for (const part of parts) {
        const partNumber = (part.getAttribute('N') || '').trim();
        if (!shouldKeepPartNumber(partNumber)) {
            part.parentNode.removeChild(part);
        }
    }

    pruneEmptyContainers(doc);
    return serializeXml(doc);
}

function normalizePartNumber(value) {
    const text = normalizeWhitespace(value);
    if (!text) return '';

    const fromEar = getPartNumberFromEar(text);
    const fromHeading = getPartNumberFromHeading(text);
    const candidate = normalizeWhitespace(fromEar || fromHeading || text)
        .replace(/^part\s*/i, '')
        .replace(/^pt\.?\s*/i, '')
        .replace(/[^A-Za-z0-9.\-]+/g, '');

    return candidate.replace(/^0+(?=\d)/, '');
}

function getPartNumberFromHeading(headingText) {
    const text = normalizeWhitespace(headingText);
    const match = text.match(/^PARTS?\s+([A-Za-z0-9]+(?:\s*-\s*[A-Za-z0-9]+)?)/i);
    return match ? match[1].replace(/\s+/g, '') : '';
}

function shouldKeepPartNumber(value) {
    const partNumber = normalizePartNumber(value);
    return partNumber ? KEEP_PART_NUMBERS.has(partNumber) : false;
}

function appendTextElement(doc, parent, name, text, attrs = null) {
    const el = doc.createElement(name);
    if (attrs) {
        for (const [key, value] of Object.entries(attrs)) {
            if (value !== undefined && value !== null && value !== '') {
                el.setAttribute(key, String(value));
            }
        }
    }
    if (text !== undefined && text !== null && text !== '') {
        el.appendChild(doc.createTextNode(text));
    }
    parent.appendChild(el);
    return el;
}

function parseTitleText(head) {
    const normalized = normalizeWhitespace(head);
    const match = normalized.match(/^Title\s+\d+\s*[—-]\s*(.+)$/i);
    return normalizeWhitespace(match ? match[1] : normalized);
}

function parseChapterTitle(head) {
    const normalized = normalizeWhitespace(head);
    const match = normalized.match(/^CHAPTER\s+[A-Z0-9IVXLCDM]+\s*[—-]\s*(.+)$/i);
    return normalizeWhitespace(match ? match[1] : normalized);
}

function parseSectionHead(headText, fallbackNumber) {
    const normalized = normalizeWhitespace(headText);
    const fallback = normalizeWhitespace(fallbackNumber).replace(/^§{1,2}\s*/u, '');

    const marker = normalized.match(/^(§{1,2})\s*/u)?.[1] || '§';
    let remainder = normalized.replace(/^§{1,2}\s*/u, '');
    remainder = remainder.replace(/^(?:section|sec\.)\s+/iu, '');

    if (fallback) {
        const flexibleCitation = escapeRegExp(fallback)
            .replace(/-/g, '\\s*[-–—]\\s*')
            .replace(/ /g, '\\s+');
        const citationMatch = remainder.match(
            new RegExp(`^${flexibleCitation}(?:\\s+|\\s*[-–—:]\\s*|$)(.*)$`, 'iu')
        );
        if (citationMatch) {
            return {
                sectionNumber: `${marker} ${fallback}`,
                contentsNumber: fallback,
                subject: normalizeWhitespace(citationMatch[1])
            };
        }
    }

    if (!normalized) {
        const sectionNumber = fallback ? `§ ${fallback}` : '';
        return {
            sectionNumber,
            contentsNumber: fallback,
            subject: ''
        };
    }

    const sectionMatch = normalized.match(/^(§{1,2})\s*([^\s]+(?:\s*[-–—]\s*[^\s]+)?)\s*(.*)$/u);
    if (sectionMatch) {
        const sectionNumber = `${sectionMatch[1]} ${sectionMatch[2]}`.trim();
        const contentsNumber = fallback || normalizeWhitespace(sectionMatch[2]);
        const subject = normalizeWhitespace(sectionMatch[3]);
        return { sectionNumber, contentsNumber, subject };
    }

    const sectionNumber = fallback ? `§ ${fallback}` : normalized;
    const subject = fallback ? normalized : '';
    return {
        sectionNumber: normalizeWhitespace(sectionNumber),
        contentsNumber: fallback,
        subject
    };
}

function mapAuthOrSourceNode(srcNode, outDoc) {
    const outNode = outDoc.createElement(srcNode.nodeName);

    const hedText = normalizeWhitespace(xpath.select1('string(./HED)', srcNode));
    if (hedText) {
        appendTextElement(outDoc, outNode, 'HD', hedText, { SOURCE: 'HED' });
    }

    const pspaceNodes = xpath.select('./PSPACE', srcNode);
    if (pspaceNodes.length > 0) {
        for (const pspace of pspaceNodes) {
            const p = outDoc.createElement('P');
            const pText = normalizeWhitespace(xpath.select1('string(.)', pspace));
            if (pText) p.appendChild(outDoc.createTextNode(pText));
            outNode.appendChild(p);
        }
        return outNode;
    }

    const pNodes = xpath.select('./P', srcNode);
    if (pNodes.length > 0) {
        for (const pSrc of pNodes) {
            outNode.appendChild(pSrc.cloneNode(true));
        }
        return outNode;
    }

    const fallbackText = normalizeWhitespace(xpath.select1('string(.)', srcNode));
    if (fallbackText) {
        appendTextElement(outDoc, outNode, 'P', fallbackText);
    }
    return outNode;
}

function addContentsSectionEntry(sectionDiv, outDoc, parentNode) {
    const sectionHead = normalizeWhitespace(xpath.select1('string(./HEAD)', sectionDiv));
    const parsed = parseSectionHead(sectionHead, sectionDiv.getAttribute('N') || '');
    const sectno = normalizeWhitespace(parsed.contentsNumber || parsed.sectionNumber.replace(/^§+\s*/u, ''));
    const subject = normalizeWhitespace(parsed.subject);

    if (sectno) appendTextElement(outDoc, parentNode, 'SECTNO', sectno);
    if (subject) appendTextElement(outDoc, parentNode, 'SUBJECT', subject);
}

function mapSectionNode(sectionDiv, outDoc) {
    const sectionOut = outDoc.createElement('SECTION');

    const sectionHead = normalizeWhitespace(xpath.select1('string(./HEAD)', sectionDiv));
    const parsed = parseSectionHead(sectionHead, sectionDiv.getAttribute('N') || '');
    if (parsed.sectionNumber) appendTextElement(outDoc, sectionOut, 'SECTNO', parsed.sectionNumber);
    if (parsed.subject) appendTextElement(outDoc, sectionOut, 'SUBJECT', parsed.subject);

    for (const child of getElementChildren(sectionDiv)) {
        if (child.nodeName === 'HEAD') continue;
        sectionOut.appendChild(child.cloneNode(true));
    }

    normalizeSectionParagraphStructure(sectionOut, outDoc);

    return sectionOut;
}

function mapAppendixNode(appendixDiv, outDoc) {
    const appOut = outDoc.createElement('APPENDIX');
    const earText = normalizeWhitespace(appendixDiv.getAttribute('N') || '');
    const headText = normalizeWhitespace(xpath.select1('string(./HEAD)', appendixDiv));

    if (earText) appendTextElement(outDoc, appOut, 'EAR', earText);
    if (headText) appendTextElement(outDoc, appOut, 'HD', headText, { SOURCE: 'HED' });

    for (const child of getElementChildren(appendixDiv)) {
        if (child.nodeName === 'HEAD') continue;
        appOut.appendChild(child.cloneNode(true));
    }

    return appOut;
}

type ChildMapper = (source: Element, output: Document) => Element;

/** Each container declares its recognized children; all other elements pass through. */
function appendMappedChildren(source: Element, target: Element, output: Document, mappers: Record<string, ChildMapper>) {
    for (const child of getElementChildren(source)) {
        if (child.nodeName === 'HEAD') continue;
        const type = (child.getAttribute('TYPE') || '').toUpperCase();
        const mapper = Object.hasOwn(mappers, child.nodeName)
            ? mappers[child.nodeName] : mappers[`${child.nodeName}:${type}`];
        target.appendChild(mapper ? mapper(child, output) : child.cloneNode(true));
    }
}

function mapSubjectGroupNode(subjgrpDiv, outDoc) {
    const groupOut = outDoc.createElement('SUBJGRP');
    const headText = normalizeWhitespace(xpath.select1('string(./HEAD)', subjgrpDiv));
    if (headText) appendTextElement(outDoc, groupOut, 'HD', headText, { SOURCE: 'HED' });

    appendMappedChildren(subjgrpDiv, groupOut, outDoc, {
        'DIV8:SECTION': mapSectionNode,
        'DIV9:APPENDIX': mapAppendixNode
    });

    return groupOut;
}

function mapSubpartNode(subpartDiv, outDoc) {
    const subpartOut = outDoc.createElement('SUBPART');
    const headText = normalizeWhitespace(xpath.select1('string(./HEAD)', subpartDiv));
    if (headText) appendTextElement(outDoc, subpartOut, 'HD', headText, { SOURCE: 'HED' });

    appendMappedChildren(subpartDiv, subpartOut, outDoc, {
        AUTH: mapAuthOrSourceNode,
        SOURCE: mapAuthOrSourceNode,
        'DIV7:SUBJGRP': mapSubjectGroupNode,
        'DIV8:SECTION': mapSectionNode,
        'DIV9:APPENDIX': mapAppendixNode
    });

    return subpartOut;
}

function buildPartContents(partDiv, outDoc) {
    const contents = outDoc.createElement('CONTENTS');
    appendTextElement(outDoc, contents, 'SECHD', 'Sec.');

    function buildSubjectGroupContents(subjgrpDiv) {
        const subjgrp = outDoc.createElement('SUBJGRP');
        const grpHead = normalizeWhitespace(xpath.select1('string(./HEAD)', subjgrpDiv));
        if (grpHead) appendTextElement(outDoc, subjgrp, 'HD', grpHead, { SOURCE: 'HED' });
        for (const secInGrp of getElementChildren(subjgrpDiv)) {
            const secType = (secInGrp.getAttribute('TYPE') || '').toUpperCase();
            if (secInGrp.nodeName === 'DIV8' && secType === 'SECTION') {
                addContentsSectionEntry(secInGrp, outDoc, subjgrp);
            }
        }
        return subjgrp;
    }

    for (const child of getElementChildren(partDiv)) {
        const childType = (child.getAttribute('TYPE') || '').toUpperCase();

        if (child.nodeName === 'DIV8' && childType === 'SECTION') {
            addContentsSectionEntry(child, outDoc, contents);
            continue;
        }

        if (child.nodeName === 'DIV7' && childType === 'SUBJGRP') {
            contents.appendChild(buildSubjectGroupContents(child));
            continue;
        }

        if (child.nodeName === 'DIV6' && childType === 'SUBPART') {
            const subpartContents = outDoc.createElement('SUBPART');
            const subpartHead = normalizeWhitespace(xpath.select1('string(./HEAD)', child));
            if (subpartHead) {
                appendTextElement(outDoc, subpartContents, 'HD', subpartHead, { SOURCE: 'HED' });
            }

            for (const subChild of getElementChildren(child)) {
                const subChildType = (subChild.getAttribute('TYPE') || '').toUpperCase();
                if (subChild.nodeName === 'DIV8' && subChildType === 'SECTION') {
                    addContentsSectionEntry(subChild, outDoc, subpartContents);
                    continue;
                }
                if (subChild.nodeName === 'DIV7' && subChildType === 'SUBJGRP') {
                    subpartContents.appendChild(buildSubjectGroupContents(subChild));
                }
            }
            contents.appendChild(subpartContents);
            continue;
        }

        if (child.nodeName === 'DIV9' && childType === 'APPENDIX') {
            const appEntry = normalizeWhitespace(child.getAttribute('N') || xpath.select1('string(./HEAD)', child));
            if (appEntry) appendTextElement(outDoc, contents, 'APP', appEntry);
        }
    }

    return contents;
}

function mapPartNode(partDiv, outDoc) {
    const partOut = outDoc.createElement('PART');
    const partNumber = normalizeWhitespace(partDiv.getAttribute('N') || '');
    const partHeading = normalizeWhitespace(xpath.select1('string(./HEAD)', partDiv));

    if (partNumber) appendTextElement(outDoc, partOut, 'EAR', `Pt. ${partNumber}`);
    if (partHeading) appendTextElement(outDoc, partOut, 'HD', partHeading, { SOURCE: 'HED' });

    partOut.appendChild(buildPartContents(partDiv, outDoc));

    appendMappedChildren(partDiv, partOut, outDoc, {
        AUTH: mapAuthOrSourceNode,
        SOURCE: mapAuthOrSourceNode,
        'DIV6:SUBPART': mapSubpartNode,
        'DIV8:SECTION': mapSectionNode,
        'DIV7:SUBJGRP': mapSubjectGroupNode,
        'DIV9:APPENDIX': mapAppendixNode
    });

    return partOut;
}

function mapSubchapterNode(subchapDiv, outDoc) {
    const subchapOut = outDoc.createElement('SUBCHAP');
    const subchapType = normalizeWhitespace(subchapDiv.getAttribute('N') || '');
    if (subchapType) subchapOut.setAttribute('TYPE', subchapType);

    const headText = normalizeWhitespace(xpath.select1('string(./HEAD)', subchapDiv));
    if (headText) appendTextElement(outDoc, subchapOut, 'HD', headText, { SOURCE: 'HED' });

    for (const child of getElementChildren(subchapDiv)) {
        const childType = (child.getAttribute('TYPE') || '').toUpperCase();
        if (child.nodeName === 'DIV5' && childType === 'PART') {
            subchapOut.appendChild(mapPartNode(child, outDoc));
        }
    }

    return subchapOut;
}

function convertEcfrToGovInfoLikeXml(ecfrXml, { titleNumber, date, chapterCode, volumeSet }) {
    const ecfrDoc = parseXml(ecfrXml);
    const outDoc = parseXml('<CFRDOC/>');
    const root = outDoc.documentElement;

    const titleHead = normalizeWhitespace(xpath.select1('string(//DIV1[@TYPE="TITLE"]/HEAD)', ecfrDoc));
    const normalizedChapterCode = normalizeWhitespace(chapterCode);
    const chapterDiv = xpath.select('//DIV3[@TYPE="CHAPTER"]', ecfrDoc)
        .find(node => node.nodeType === 1 &&
            normalizeWhitespace(node.getAttribute('N') || '') === normalizedChapterCode);
    if (!chapterDiv) {
        throw new Error(`Could not find chapter ${chapterCode} in eCFR payload`);
    }
    const chapterHead = normalizeWhitespace(xpath.select1('string(./HEAD)', chapterDiv));

    const volumeLabel = Array.from(volumeSet)
        .sort((a, b) => Number(a) - Number(b))
        .join(',');

    const fdsys = outDoc.createElement('FDSYS');
    appendTextElement(outDoc, fdsys, 'CFRTITLE', String(titleNumber));
    appendTextElement(outDoc, fdsys, 'CFRTITLETEXT', parseTitleText(titleHead));
    appendTextElement(outDoc, fdsys, 'VOL', volumeLabel);
    appendTextElement(outDoc, fdsys, 'DATE', date);
    appendTextElement(outDoc, fdsys, 'COVERONLY', 'false');
    appendTextElement(outDoc, fdsys, 'ORIGINALDATE', date);
    appendTextElement(outDoc, fdsys, 'HEADING', `Chapter ${chapterCode}`);
    appendTextElement(outDoc, fdsys, 'TITLE', parseChapterTitle(chapterHead));
    const ancestors = outDoc.createElement('ANCESTORS');
    appendTextElement(outDoc, ancestors, 'PARENT', parseTitleText(titleHead), {
        HEADING: `Title ${titleNumber}`,
        SEQ: '0'
    });
    fdsys.appendChild(ancestors);
    root.appendChild(fdsys);

    const chapterOut = outDoc.createElement('CHAPTER');
    for (const subchap of xpath.select('./DIV4[@TYPE="SUBCHAP"]', chapterDiv)) {
        chapterOut.appendChild(mapSubchapterNode(subchap, outDoc));
    }

    for (const part of xpath.select('./DIV5[@TYPE="PART"]', chapterDiv)) {
        chapterOut.appendChild(mapPartNode(part, outDoc));
    }

    root.appendChild(chapterOut);
    return serializeXml(outDoc);
}

function getPartNumberFromEar(earText) {
    const text = normalizeWhitespace(earText);
    const match = text.match(/Pt\.\s*([A-Za-z0-9.\-]+)/i);
    return match ? match[1] : '';
}

function stripXmlDeclaration(xml) {
    return String(xml || '').replace(/^\s*<\?xml[\s\S]*?\?>\s*/i, '');
}

function pruneFarDocContainers(doc) {
    const subchaps = xpath.select('//SUBCHAP', doc);
    for (const subchap of subchaps) {
        const partsInside = xpath.select('.//PART', subchap);
        if (partsInside.length === 0) {
            subchap.parentNode.removeChild(subchap);
        }
    }
}

function filterFarXmlByKeepParts(farXml) {
    const doc = parseXml(farXml);
    const partNodes = xpath.select('//PART', doc);

    for (const partNode of partNodes) {
        const attrPart = normalizeWhitespace(partNode.getAttribute('N') || '');
        const ear = normalizeWhitespace(xpath.select1('string(./EAR)', partNode));
        const heading = normalizeWhitespace(xpath.select1('string(./HD)', partNode));
        const candidate = attrPart || ear || heading;
        if (!shouldKeepPartNumber(candidate)) {
            partNode.parentNode.removeChild(partNode);
        }
    }

    pruneFarDocContainers(doc);
    for (const section of xpath.select('//SECTION', doc)) {
        normalizeSectionParagraphStructure(section, doc);
    }
    return serializeXml(doc);
}

function resolveAnnualDisplayDate({ explicitDate, year, annualCombinedXml }) {
    if (explicitDate) return explicitDate;
    try {
        const doc = parseXml(annualCombinedXml);
        const date = normalizeWhitespace(xpath.select1('string(//FDSYS/DATE)', doc));
        if (date) return date;
    } catch {
        // Ignore parse errors; fall back below.
    }
    return year ? `${year}-01-01` : 'unknown';
}

function buildSinglePartFarXmlByIndex(farXml, partIndex) {
    const doc = parseXml(farXml);
    const parts = xpath.select('//PART', doc);
    const contentParts = parts.filter(part => xpath.select('./RESERVED', part).length === 0);
    const selectedPart = contentParts[partIndex];
    for (const part of parts) {
        if (part !== selectedPart) {
            part.parentNode.removeChild(part);
        }
    }
    pruneFarDocContainers(doc);
    return serializeXml(doc);
}

export {
    parseXml,
    serializeXml,
    filterByVolumes,
    filterByKeepParts,
    normalizeWhitespace,
    normalizePartNumber,
    shouldKeepPartNumber,
    getPartNumberFromHeading,
    parseSectionHead,
    convertEcfrToGovInfoLikeXml,
    getPartNumberFromEar,
    stripXmlDeclaration,
    filterFarXmlByKeepParts,
    resolveAnnualDisplayDate,
    buildSinglePartFarXmlByIndex
};
