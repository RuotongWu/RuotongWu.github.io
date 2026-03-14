#!/usr/bin/env node

/**
 * 小宇宙播客下载器 - 本地服务器
 * 提供API服务，解决跨域问题
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { URL } = require('url');
const { exec } = require('child_process');
const crypto = require('crypto');

const PORT = 3000;
const XIAOYUHOST = 'www.xiaoyuzhoufm.com';

// 莫兰迪色系日志
const colors = {
    reset: '\x1b[0m',
    green: '\x1b[38;2;139;190;141m',
    red: '\x1b[38;2;191;127;141m',
    yellow: '\x1b[38;2;204;183;121m',
    blue: '\x1b[38;2;141;169;196m',
    gray: '\x1b[38;2;180;180;180m'
};

function log(msg, color = 'gray') {
    console.log(colors[color] + msg + colors.reset);
}

function httpGet(url) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        const client = parsedUrl.protocol === 'https:' ? https : http;

        const options = {
            hostname: parsedUrl.hostname,
            path: parsedUrl.pathname + parsedUrl.search,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/json, text/html, */*',
                'Referer': 'https://www.xiaoyuzhoufm.com/'
            }
        };

        client.get(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ status: res.statusCode, data }));
        }).on('error', reject);
    });
}

function downloadFile(url, filepath) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        const client = parsedUrl.protocol === 'https:' ? https : http;

        const options = {
            hostname: parsedUrl.hostname,
            path: parsedUrl.pathname + parsedUrl.search,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        };

        const file = fs.createWriteStream(filepath);
        client.get(options, (res) => {
            if (res.statusCode === 302 || res.statusCode === 301) {
                file.close();
                fs.unlink(filepath, () => {});
                downloadFile(res.headers.location, filepath).then(resolve).catch(reject);
                return;
            }
            res.pipe(file);
            file.on('finish', () => {
                file.close();
                resolve();
            });
        }).on('error', (err) => {
            fs.unlink(filepath, () => {});
            reject(err);
        });
    });
}

function extractEpisodeId(url) {
    const match = url.match(/episode\/([a-zA-Z0-9]+)/);
    return match ? match[1] : null;
}

function sanitizeFilename(name) {
    return name.replace(/[<>:"/\\|?*]/g, '_').substring(0, 100);
}

function getDownloadDir() {
    return path.join(os.homedir(), 'Downloads');
}

async function getEpisodeInfo(episodeId) {
    const pageUrl = `https://${XIAOYUHOST}/episode/${episodeId}`;
    const pageRes = await httpGet(pageUrl);

    if (pageRes.status !== 200) {
        throw new Error('无法获取页面');
    }

    let title = '播客音频_' + episodeId;

    // 从title标签提取
    const titleMatch = pageRes.data.match(/<title>([^<]+)/);
    if (titleMatch) {
        const fullTitle = titleMatch[1];
        title = fullTitle.split(' - ')[0] || fullTitle.split(' | ')[0] || title;
    }

    // 从JSON提取更准确的标题
    const jsonMatch = pageRes.data.match(/window\.__INITIAL_STATE__\s*=\s*(\{[^;]+\})/);
    if (jsonMatch) {
        try {
            const data = JSON.parse(jsonMatch[1]);
            const episodeData = data?.episode || data?.episodeDetail || data?.data?.episode;
            if (episodeData?.title) {
                title = episodeData.title;
            }
        } catch (e) {}
    }

    // 提取m4a URL
    const m4aMatch = pageRes.data.match(/https:\/\/[^"'\s<>]+\.m4a[^"'\s<>]*/);
    if (m4aMatch) {
        return { title, audioUrl: m4aMatch[0] };
    }

    // 从JSON获取音频URL
    if (jsonMatch) {
        try {
            const data = JSON.parse(jsonMatch[1]);
            const episodeData = data?.episode || data?.episodeDetail || data?.data?.episode;
            if (episodeData?.audioUrl) {
                return { title, audioUrl: episodeData.audioUrl };
            }
        } catch (e) {}
    }

    throw new Error('无法获取音频信息');
}

// NCM转MP3功能
function parseNcm(buffer) {
    // 检查ncm文件头
    if (buffer.slice(0, 4).toString() !== 'ncmk') {
        throw new Error('无效的NCM文件');
    }

    // 读取密钥长度 (偏移量8-11)
    const keyLength = buffer.readUInt32LE(8);

    // 读取加密的密钥数据 (从偏移量12开始)
    const encryptedKey = buffer.slice(12, 12 + keyLength);

    // NCM解密密钥 (固定的 "dap" + "ang" = "dapang")
    const coreKey = [0x64, 0x61, 0x70, 0x61, 0x6E, 0x67];
    const adjustKey = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00];

    // 解密密钥
    const decryptedKey = [];
    for (let i = 0; i < encryptedKey.length; i++) {
        decryptedKey.push(encryptedKey[i] ^ coreKey[i % 6] ^ adjustKey[i % 6]);
    }

    // 从解密后的密钥提取RC4密钥
    const rc4Key = decryptedKey.slice(17);

    // RC4解密函数
    function rc4Decrypt(data, key) {
        const S = [];
        for (let i = 0; i < 256; i++) {
            S[i] = i;
        }

        let j = 0;
        for (let i = 0; i < 256; i++) {
            j = (j + S[i] + key[i % key.length]) % 256;
            [S[i], S[j]] = [S[j], S[i]];
        }

        const result = Buffer.alloc(data.length);
        let i = 0, k = 0;
        for (let n = 0; n < data.length; n++) {
            i = (i + 1) % 256;
            k = (k + S[i]) % 256;
            [S[i], S[k]] = [S[k], S[i]];
            result[n] = data[n] ^ S[(S[i] + S[k]) % 256];
        }

        return result;
    }

    // 跳过ncm头 (12 + keyLength + 64 = 76 + keyLength)
    const musicOffset = 76 + keyLength;
    const musicData = buffer.slice(musicOffset);

    // 使用RC4解密音乐数据
    const decryptedMusic = rc4Decrypt(musicData, rc4Key);

    return decryptedMusic;
}

function convertToMp3(inputBuffer, outputPath) {
    return new Promise((resolve, reject) => {
        const tempPath = path.join(os.tmpdir(), `ncm_temp_${Date.now()}.flac`);

        // 写入临时文件
        fs.writeFile(tempPath, inputBuffer, (err) => {
            if (err) {
                reject(err);
                return;
            }

            // 使用ffmpeg转换
            exec(`ffmpeg -i "${tempPath}" -y -ab 320k "${outputPath}"`, (error, stdout, stderr) => {
                // 删除临时文件
                fs.unlink(tempPath, () => {});

                if (error) {
                    reject(new Error('ffmpeg转换失败，请确保已安装ffmpeg'));
                    return;
                }
                resolve();
            });
        });
    });
}

// API路由处理
async function handleApi(req, res) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const pathname = url.pathname;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    try {
        if (pathname === '/api/parse') {
            const episodeUrl = url.searchParams.get('url');
            if (!episodeUrl) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: '缺少url参数' }));
                return;
            }

            const episodeId = extractEpisodeId(episodeUrl);
            if (!episodeId) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: '无法解析播客链接' }));
                return;
            }

            log(`解析播客: ${episodeId}`, 'blue');
            const info = await getEpisodeInfo(episodeId);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, data: info }));

        } else if (pathname === '/api/download') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', async () => {
                const { audioUrl, title } = JSON.parse(body);

                const filename = sanitizeFilename(title) + '.m4a';
                const downloadDir = getDownloadDir();
                const filepath = path.join(downloadDir, filename);

                log(`下载音频: ${title}`, 'blue');
                await downloadFile(audioUrl, filepath);

                log(`下载完成: ${filepath}`, 'green');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, filepath }));

            });

        } else if (pathname === '/api/ncm/convert') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', async () => {
                try {
                    const { filename, data } = JSON.parse(body);
                    // data是base64编码的文件内容
                    const buffer = Buffer.from(data, 'base64');

                    log(`转换NCM: ${filename}`, 'blue');

                    // 解析NCM
                    const decryptedMusic = parseNcm(buffer);

                    // 生成输出文件名
                    let baseName = filename.replace(/\.ncm$/i, '');
                    // 尝试从原始数据中提取更多信息作为文件名
                    const outputName = sanitizeFilename(baseName) + '.mp3';
                    const outputPath = path.join(getDownloadDir(), outputName);

                    // 转换为MP3
                    await convertToMp3(decryptedMusic, outputPath);

                    log(`转换完成: ${outputPath}`, 'green');
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, filepath: outputPath }));

                } catch (error) {
                    log(`转换错误: ${error.message}`, 'red');
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: error.message }));
                }
            });

        } else {
            res.writeHead(404);
            res.end('Not Found');
        }
    } catch (error) {
        log(`错误: ${error.message}`, 'red');
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
    }
}

// 静态文件服务
function serveStatic(req, res) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    let filepath = url.pathname;

    if (filepath === '/') {
        filepath = '/index.html';
    }

    const staticPath = path.join(__dirname, 'public', filepath);
    const ext = path.extname(staticPath);
    const contentTypes = {
        '.html': 'text/html',
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.json': 'application/json'
    };

    fs.readFile(staticPath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('Not Found');
            return;
        }
        res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'text/plain' });
        res.end(data);
    });
}

const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname.startsWith('/api/')) {
        handleApi(req, res);
    } else {
        serveStatic(req, res);
    }
});

server.listen(PORT, () => {
    console.log(`
${colors.green}╔═══════════════════════════════════════╗${colors.reset}
${colors.green}║     小宇宙播客下载器                   ║${colors.reset}
${colors.green}║                                       ║${colors.reset}
${colors.green}║   🌐 访问: http://localhost:${PORT}    ║${colors.reset}
${colors.green}║                                       ║${colors.reset}
${colors.green}║   📥 下载保存至: ~/Downloads           ║${colors.reset}
${colors.green}╚═══════════════════════════════════════╝${colors.reset}
    `);
});
