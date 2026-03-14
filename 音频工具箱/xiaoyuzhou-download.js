#!/usr/bin/env node

/**
 * 小宇宙播客下载器
 * 使用方法: node xiaoyuzhou-download.js <播客链接>
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { URL } = require('url');

// 莫兰迪色系
const colors = {
    reset: '\x1b[0m',
    green: '\x1b[38;2;139;190;141m',    // 莫兰迪绿
    red: '\x1b[38;2;191;127;141m',      // 莫兰迪红
    yellow: '\x1b[38;2;204;183;121m',   // 莫兰迪黄
    blue: '\x1b[38;2;141;169;196m',     // 莫兰迪蓝
    gray: '\x1b[38;2;180;180;180m'      // 莫兰迪灰
};

function log(msg, color = 'reset') {
    console.log(colors[color] + msg + colors.reset);
}

function extractEpisodeId(url) {
    const match = url.match(/episode\/([a-zA-Z0-9]+)/);
    return match ? match[1] : null;
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
                // 重定向
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

async function getEpisodeInfo(episodeId) {
    log(`\n${colors.blue}正在获取播客信息...${colors.reset}`);

    // 尝试获取页面
    const pageUrl = `https://www.xiaoyuzhoufm.com/episode/${episodeId}`;
    const pageRes = await httpGet(pageUrl);

    if (pageRes.status === 200) {
        // 提取标题 - 多种方式尝试
        let title = '播客音频_' + episodeId;

        // 方式1: 从 title 标签提取
        const titleMatch = pageRes.data.match(/<title>([^<]+)/);
        if (titleMatch) {
            const fullTitle = titleMatch[1];
            // 格式: "标题 - 播客名 | 小宇宙" 或 "标题 | 小宇宙"
            title = fullTitle.split(' - ')[0] || fullTitle.split(' | ')[0] || title;
        }

        // 方式2: 从 JSON 数据中提取标题（更可靠）
        const jsonMatch = pageRes.data.match(/window\.__INITIAL_STATE__\s*=\s*(\{[^;]+\})/);
        if (jsonMatch) {
            try {
                const data = JSON.parse(jsonMatch[1]);
                // 尝试多种数据结构
                const episodeData = data?.episode || data?.episodeDetail || data?.data?.episode;
                if (episodeData?.title) {
                    title = episodeData.title;
                }
            } catch (e) {
                log(`${colors.gray}JSON解析标题失败，使用title标签${colors.reset}`);
            }
        }

        log(`${colors.gray}提取到标题: ${title}${colors.reset}`);

        // 方式1: 直接提取 .m4a URL
        const m4aMatch = pageRes.data.match(/https:\/\/[^"'\s<>]+\.m4a[^"'\s<>]*/);
        if (m4aMatch) {
            return {
                title: title,
                audioUrl: m4aMatch[0],
                duration: 0
            };
        }

        // 方式2: 从页面提取JSON数据获取音频URL
        if (jsonMatch) {
            try {
                const data = JSON.parse(jsonMatch[1]);
                // 尝试多种数据结构路径
                const episodeData = data?.episode || data?.episodeDetail || data?.data?.episode;
                if (episodeData?.audioUrl) {
                    return {
                        title: title,
                        audioUrl: episodeData.audioUrl,
                        duration: episodeData.duration || 0
                    };
                }
                // 尝试从items数组获取
                if (data?.episodes?.items?.[0]?.audioUrl) {
                    const ep = data.episodes.items[0];
                    return {
                        title: ep.title || title,
                        audioUrl: ep.audioUrl,
                        duration: ep.duration || 0
                    };
                }
            } catch (e) {
                log(`${colors.yellow}JSON解析失败，尝试其他方式...${colors.reset}`);
            }
        }

        // 尝试其他方式提取音频URL
        const audioMatch = pageRes.data.match(/"audioUrl"\s*:\s*"([^"]+)"/) ||
                           pageRes.data.match(/audioUrl\s*:\s*'([^']+)'/);
        if (audioMatch) {
            return {
                title: title,
                audioUrl: audioMatch[1],
                duration: 0
            };
        }

        // 尝试提取playUrl
        const playUrlMatch = pageRes.data.match(/"playUrl"\s*:\s*"([^"]+)"/);
        if (playUrlMatch) {
            return {
                title: title,
                audioUrl: playUrlMatch[1],
                duration: 0
            };
        }

        // 尝试提取 mediaUrl
        const mediaUrlMatch = pageRes.data.match(/"mediaUrl"\s*:\s*"([^"]+)"/);
        if (mediaUrlMatch) {
            return {
                title: title,
                audioUrl: mediaUrlMatch[1],
                duration: 0
            };
        }
    }

    throw new Error('无法获取音频信息，请检查链接是否正确');
}

function sanitizeFilename(name) {
    return name.replace(/[<>:"/\\|?*]/g, '_').substring(0, 100);
}

function formatDuration(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}分${secs}秒`;
}

// 获取用户下载目录
function getDownloadDir() {
    const homeDir = os.homedir();
    // macOS 默认下载目录
    return path.join(homeDir, 'Downloads');
}

async function main() {
    const args = process.argv.slice(2);

    if (args.length === 0) {
        console.log(`
${colors.green}小宇宙播客下载器${colors.reset}

用法: node xiaoyuzhou-download.js <播客链接>

示例: node xiaoyuzhou-download.js https://www.xiaoyuzhoufm.com/episode/699dadeade29766da9636a9b
        `);
        process.exit(1);
    }

    const url = args[0];
    const episodeId = extractEpisodeId(url);

    if (!episodeId) {
        log('错误: 无法从链接中提取播客ID，请检查链接格式', 'red');
        process.exit(1);
    }

    log(`解析到播客ID: ${episodeId}`);

    try {
        const info = await getEpisodeInfo(episodeId);

        log(`\n${colors.green}✓ 获取成功！${colors.reset}`);
        log(`标题: ${info.title}`);
        log(`时长: ${info.duration ? formatDuration(info.duration) : '未知'}`);
        log(`音频地址: ${info.audioUrl}`);

        // 使用标题作为文件名，保存到下载目录
        const filename = sanitizeFilename(info.title) + '.m4a';
        const downloadDir = getDownloadDir();
        const filepath = path.join(downloadDir, filename);

        log(`\n${colors.blue}正在下载音频到: ${filepath}${colors.reset}...`);

        await downloadFile(info.audioUrl, filepath);

        log(`\n${colors.green}✓ 下载完成！${colors.reset}`);
        log(`文件保存为: ${filepath}`);

    } catch (error) {
        log(`\n${colors.red}错误: ${error.message}${colors.reset}`);
        process.exit(1);
    }
}

main();
