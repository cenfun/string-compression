const fs = require('fs');
const path = require('path');
const CG = require('console-grid');
const EC = require('eight-colors');
const esbuild = require('esbuild');
const { chromium } = require('@playwright/test');

const lz = require('lz-utils');
const fflate = require('fflate');
const uzip = require('uzip');
const pako = require('pako');
const zlib = require('zlib');

const hasOwn = function(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
};

const replace = function(str, obj) {
    str = `${str}`;
    if (!obj) {
        return str;
    }
    str = str.replace(/\{([^}{]+)\}/g, function(match, key) {
        if (!hasOwn(obj, key)) {
            return match;
        }
        return obj[key];
    });
    return str;
};

const buildItem = async (util, srcPath, distDir) => {

    const outfile = path.resolve(distDir, `${util.filename}.js`);

    const result = await esbuild.build({
        entryPoints: [srcPath],
        outfile,
        minify: true,
        metafile: true,
        bundle: true,
        // format: 'cjs',
        legalComments: 'none',
        target: 'node16',
        platform: 'node'
    });

    const metafile = result.metafile;
    const metaPath = path.resolve(distDir, `${util.filename}.json`);
    fs.writeFileSync(metaPath, JSON.stringify(metafile, null, 4));

    return outfile;
};

const saveHtml = (util, distDir) => {
    const template = fs.readFileSync(path.resolve(__dirname, './template.html')).toString('utf-8');
    const html = replace(template, {
        title: util.filename,
        content: `<script src="${util.filename}.js"></script>`
    });
    const htmlPath = path.resolve(distDir, `${util.filename}.html`);
    fs.writeFileSync(htmlPath, html);

    return htmlPath;
};

const decompressItem = async (item) => {

    const {
        filename, htmlPath, distDir, fileStr, browser
    } = item;

    const page = await browser.newPage();
    const watcher = page.waitForFunction(() => window.decompressed);
    await page.goto(`file://${path.resolve(htmlPath)}`);
    await watcher;

    const decompressed = await page.evaluate(() => {
        return window.decompressed;
    });

    await page.close();

    if (decompressed.value === fileStr) {
        EC.logGreen(`${filename} matched`);
    } else {
        EC.logRed(`${filename} unmatched`);
        fs.writeFileSync(path.resolve(distDir, `${filename}.decompressed`), decompressed.value);
    }

    return decompressed.duration;
};

const initDirs = () => {
    const dirs = {
        srcDir: 'src',
        distDir: 'dist'
    };
    Object.keys(dirs).forEach((k) => {
        const dir = path.resolve(__dirname, `../${dirs[k]}`);
        if (fs.existsSync(dir)) {
            fs.rmSync(dir, {
                recursive: true,
                force: true
            });
        }
        fs.mkdirSync(dir);
        dirs[k] = dir;
    });
    return dirs;
};

const compressItem = async (item) => {

    const {
        jsonName, jsonPath, srcDir, distDir, browser
    } = item;

    // https://developer.mozilla.org/en-US/docs/Glossary/Base64

    const utils = [
        {
            name: 'lz',
            compress: lz.compress,
            src: (filename) => {
                return `
                    import { decompress } from 'lz-utils';
                    import compressed from "./${filename}";

                    const time_start = Date.now();
                    const res = decompress(compressed);

                    const duration = Date.now() - time_start;
                    console.log(duration);

                    window.decompressed = {
                        duration,
                        value: res
                    };

                    console.log(JSON.parse(res));
                `;
            }
        },
        {
            name: 'fflate',
            compress: (str) => {
                const buf = fflate.strToU8(str);
                const compressedString = fflate.compressSync(buf);
                return Buffer.from(compressedString).toString('base64');
            },
            src: (filename) => {
                return `
                    import { decompressSync } from 'fflate/browser';
                    import compressedB64 from "./${filename}";

                    import { b64ToU8a, uint8ArrToString } from "../scripts/b64-to-u8a.js";
                    
                    const time_start = Date.now();

                    const buff = b64ToU8a(compressedB64);
                    const u8a = decompressSync(buff);
                    const res = uint8ArrToString(u8a);

                    const duration = Date.now() - time_start;
                    console.log(duration);

                    window.decompressed = {
                        duration,
                        value: res
                    };

                    console.log(JSON.parse(res));
                `;
            }
        },
        {
            name: 'uzip',
            compress: (str) => {
                const buf = Buffer.from(str);
                const compressed = uzip.deflateRaw(buf);
                return Buffer.from(compressed).toString('base64');
            },
            src: (filename) => {
                return `
                    import { inflateRaw } from 'uzip';
                    import compressedB64 from "./${filename}";

                    import { b64ToU8a, uint8ArrToString } from "../scripts/b64-to-u8a.js";
                    
                    const time_start = Date.now();

                    const buff = b64ToU8a(compressedB64);
                    const u8a = inflateRaw(buff);
                    const res = uint8ArrToString(u8a);

                    const duration = Date.now() - time_start;
                    console.log(duration);

                    window.decompressed = {
                        duration,
                        value: res
                    };

                    console.log(JSON.parse(res));
                `;
            }
        },
        {
            name: 'pako',
            compress: (str) => {
                const compressed = pako.deflate(str);
                return Buffer.from(compressed).toString('base64');
            },
            src: (filename) => {
                return `
                    import { inflate } from 'pako';
                    import compressedB64 from "./${filename}";

                    import { b64ToU8a } from "../scripts/b64-to-u8a.js";
                    
                    const time_start = Date.now();

                    const buff = b64ToU8a(compressedB64);
                    const res = inflate(buff, { to: 'string' });

                    const duration = Date.now() - time_start;
                    console.log(duration);

                    window.decompressed = {
                        duration,
                        value: res
                    };

                    console.log(JSON.parse(res));
                `;
            }
        },
        {
            name: 'tiny',
            compress: (str) => {
                const buf = Buffer.from(str);
                const length = buf.length;
                console.log('buffer length', length, 'string length', str.length);
                const compressed = zlib.deflateRawSync(buf);
                const b64 = Buffer.from(compressed).toString('base64');
                return `${length},${b64}`;
            },
            src: (filename) => {
                return `
                    import inflate from 'tiny-inflate';
                    import compressedB64 from "./${filename}";

                    import { b64ToU8a, uint8ArrToString } from "../scripts/b64-to-u8a.js";
                    
                    const time_start = Date.now();

                    const list = compressedB64.split(",");
                
                    const decompressedSize = parseInt(list[0]);

                    //console.log("list length", list.length, "decompressedSize", decompressedSize);

                    const b64 = list[1];

                    const compressedBuffer = b64ToU8a(b64);
                    const outputBuffer = new Uint8Array(decompressedSize);
                    inflate(compressedBuffer, outputBuffer);

                    const res = uint8ArrToString(outputBuffer);

                    const duration = Date.now() - time_start;
                    //console.log(duration);

                    window.decompressed = {
                        duration,
                        value: res
                    };

                    //console.log(res);

                    console.log(JSON.parse(res));
                `;
            }
        }
    ];

    const fileStr = fs.readFileSync(jsonPath).toString('utf-8');

    const subs = [];
    for (const util of utils) {
        console.log(`compress ${jsonName} with ${util.name} ...`);

        const time_start = Date.now();
        const compressed = util.compress(fileStr);

        const filename = `${util.name}-${jsonName}`;
        util.filename = filename;

        const dataPath = path.resolve(srcDir, `${filename}.data.js`);
        fs.writeFileSync(dataPath, `module.exports = "${compressed}";`);

        const srcStr = util.src(`${filename}.data.js`);

        const srcPath = path.resolve(srcDir, `${filename}.src.js`);
        fs.writeFileSync(srcPath, srcStr);

        const outfile = await buildItem(util, srcPath, distDir);

        const duration = Date.now() - time_start;

        const stat = fs.statSync(outfile);
        const size = compressed.length;
        const distSize = stat.size;

        // decompress in browser
        const htmlPath = saveHtml(util, distDir);
        const time = await decompressItem({
            filename,
            htmlPath,
            distDir,
            fileStr,
            browser
        });

        subs.push({
            name: util.name,
            size,
            duration,
            distSize,
            jsSize: distSize - size,
            time
        });
    }

    return {
        name: jsonName,
        size: fileStr.length,
        duration: '',
        subs
    };
};

const build = async () => {

    const { srcDir, distDir } = initDirs();
    const browser = await chromium.launch();

    const jsonDir = path.resolve(__dirname, '../json');
    const list = fs.readdirSync(jsonDir);

    // list.length = 1;

    const rows = [];
    let i = 0;
    for (const jsonName of list) {
        const row = await compressItem({
            jsonName,
            jsonPath: path.resolve(jsonDir, jsonName),
            srcDir,
            distDir,
            browser
        });

        rows.push(row);
        if (i < list.length - 1) {
            rows.push({
                innerBorder: true
            });
        }
        i++;
    }

    await browser.close();

    CG({
        columns: [{
            id: 'name',
            name: 'name'
        }, {
            id: 'duration',
            name: 'c time',
            align: 'right',
            formatter: (v) => {
                if (v) {
                    return `${v.toLocaleString()} ms`;
                }
                return v;
            }
        }, {
            id: 'size',
            name: '(b64) size',
            align: 'right',
            formatter: (v) => {
                if (v) {
                    return v.toLocaleString();
                }
                return v;
            }
        }, {
            id: 'distSize',
            name: 'dist size',
            align: 'right',
            formatter: (v) => {
                if (v) {
                    return v.toLocaleString();
                }
                return v;
            }
        }, {
            id: 'jsSize',
            name: 'js size',
            align: 'right',
            formatter: (v) => {
                if (v) {
                    return v.toLocaleString();
                }
                return v;
            }
        }, {
            id: 'time',
            name: 'd time',
            align: 'right',
            formatter: (v) => {
                if (v) {
                    return `${v.toLocaleString()} ms`;
                }
                return v;
            }
        }],
        rows
    });

};

build();
