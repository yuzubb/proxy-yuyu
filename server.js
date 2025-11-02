const express = require('express');
const cors = require('cors');
const path = require('path');
const { URL } = require('url');
const cheerio = require('cheerio');

const app = express();
const PORT = 3000;

// グローバル定数としてプロキシプレフィックスを定義
const PROXY_PREFIX = '/proxy?url=';

// ミドルウェアの設定
app.use(cors());
app.use(express.static(__dirname));

/**
 * HTMLコンテンツ内のリソースURLをプロキシURLに書き換える関数
 * @param {string} html - 書き換え対象のHTMLコンテンツ
 * @param {string} originalUrl - オリジナルのページURL (相対パス解決の基点)
 * @returns {string} 書き換え後のHTMLコンテンツ
 */
function rewriteHtmlContent(html, originalUrl) {
    const $ = cheerio.load(html);
    const baseUrl = new URL(originalUrl);

    // 書き換え対象の要素セレクタ: a, form, img, CSSのlink, script, style属性を持つ全要素、video/audio/iframe/source
    const selectors = 'a, form, img, link[rel="stylesheet"], script, [style], video, audio, source, iframe'; 

    $(selectors).each((i, element) => {
        const $element = $(element);
        const tagName = $element.get(0).tagName;
        let attribute = '';
        
        // 1. タグの種類に応じて、書き換え対象の属性を決定
        switch (tagName) {
            case 'a':
                attribute = 'href';
                break;
            case 'form':
                attribute = 'action';
                break;
            case 'img':
            case 'script':
            case 'video':
            case 'audio':
            case 'iframe':
            case 'source':
                attribute = 'src';
                break;
            case 'link':
                attribute = 'href';
                break;
            default:
                break; 
        }

        // URL属性（href/src/action）の書き換え
        let originalPath = $element.attr(attribute);
        
        if (typeof originalPath === 'string' && originalPath.length > 0 && !originalPath.startsWith('data:')) {
            try {
                // 相対パスを絶対URLに変換してからプロキシURLに変換
                const absoluteUrl = new URL(originalPath, baseUrl).href;
                const proxiedUrl = PROXY_PREFIX + encodeURIComponent(absoluteUrl);
                
                $element.attr(attribute, proxiedUrl);
                
                if (tagName === 'form') {
                    // フォーム送信はGET/POSTを維持
                    $element.attr('method', $element.attr('method') ? $element.attr('method').toUpperCase() : 'GET');
                }
            } catch (e) {
                // URL変換エラーを無視
            }
        }
        
        // 2. インラインスタイル（style属性）内のurl(...)の書き換え
        const styleAttr = $element.attr('style');
        if (typeof styleAttr === 'string' && styleAttr.length > 0) { 
            const rewrittenStyle = styleAttr.replace(/url\s*\((['"]?)(.*?)\1\)/gi, (match, quote, path) => {
                if (path.startsWith('http') || path.startsWith('//') || path.startsWith('data:')) {
                    return match;
                }
                try {
                    const absoluteUrl = new URL(path, baseUrl).href;
                    const proxiedUrl = PROXY_PREFIX + encodeURIComponent(absoluteUrl);
                    return `url(${quote}${proxiedUrl}${quote})`;
                } catch (e) {
                    return match;
                }
            });
            $element.attr('style', rewrittenStyle);
        }
    });

    // <base>タグは相対パスの基準を変更してしまうため、削除
    $('base').remove();

    return $.html();
}

// -------------------------------------------------------------
// メインのプロキシエンドポイント (全HTTPメソッド対応)
// -------------------------------------------------------------
app.all('/proxy', async (req, res) => { 
    const targetUrl = req.query.url;

    if (!targetUrl) {
        return res.status(400).send({ error: 'URLパラメータが不足しています。' });
    }

    let urlObj;
    try {
        urlObj = new URL(targetUrl);
    } catch (e) {
        return res.status(400).send({ error: '無効なURL形式です。' });
    }

    if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
        return res.status(403).send({ error: 'HTTPまたはHTTPSプロトコルのみ許可されています。' });
    }

    console.log(`[PROXY] ターゲットURL: ${targetUrl}`);

    try {
        // 1. クライアントからのヘッダーとメソッドをターゲットに転送
        const headersToSend = {};
        for (const [key, value] of Object.entries(req.headers)) {
            // ホスト、接続、長さに関するヘッダーは削除または上書き
            if (!['host', 'connection', 'content-length', 'transfer-encoding', 'referer'].includes(key.toLowerCase())) {
                headersToSend[key] = value;
            }
        }
        
        // Rangeヘッダーは動画ストリーミングに必須
        if (req.headers.range) {
            headersToSend['Range'] = req.headers.range;
        }

        const fetchOptions = {
            method: req.method, // リクエストメソッドを転送
            headers: headersToSend,
            // POST/PUTなどの場合、リクエストボディも転送
            body: ['POST', 'PUT', 'PATCH'].includes(req.method) ? req : null 
        };

        const response = await fetch(targetUrl, fetchOptions);

        // 2. ターゲットからのレスポンスヘッダーをクライアントに転送
        res.status(response.status);
        const contentType = response.headers.get('content-type');
        
        response.headers.forEach((value, name) => {
            // クライアント側で問題を起こすヘッダーを削除
            if (!['connection', 'content-encoding', 'transfer-encoding', 'content-length'].includes(name.toLowerCase())) {
                res.setHeader(name, value);
            }
        });

        if (contentType && contentType.includes('text/html')) {
            // 3. HTMLの場合: URLを書き換え
            const contentBuffer = await response.arrayBuffer();
            let content = Buffer.from(contentBuffer).toString();
            content = rewriteHtmlContent(content, targetUrl);
            res.end(content);
            
        } else if (contentType && contentType.includes('text/css')) {
            // 4. CSSの場合: CSSファイル内のurl(...)を書き換え
            let cssContent = await response.text();
            
            const baseUrl = new URL(targetUrl);
            
            // CSS内の url(...) をプロキシURLに書き換える
            cssContent = cssContent.replace(/url\s*\((['"]?)(.*?)\1\)/gi, (match, quote, path) => {
                if (path.startsWith('http') || path.startsWith('//') || path.startsWith('data:')) {
                    return match;
                }
                try {
                    const absoluteUrl = new URL(path, baseUrl).href;
                    const proxiedUrl = PROXY_PREFIX + encodeURIComponent(absoluteUrl);
                    return `url(${quote}${proxiedUrl}${quote})`;
                } catch (e) {
                    return match;
                }
            });
            
            res.end(cssContent);
            
        } else {
            // 5. バイナリ/その他 (画像、JS、フォント、動画など) の場合: ストリームを直接パイプ
            // これにより、動画ストリーミングや大容量ファイルの効率的な転送を可能にする
            if (response.body) {
                // fetchのReadableStreamをNode.jsのResponseに直接パイプ
                response.body.pipe(res); 
                
                // エラー処理を追加
                response.body.on('error', (err) => {
                    console.error('[PROXY-PIPE-ERROR]', err);
                    if (!res.headersSent) res.status(500).send('ストリームエラー');
                });
            } else {
                 res.status(500).send('ターゲットサーバーからレスポンスボディがありません');
            }
        }

    } catch (error) {
        console.error(`[ERROR] プロキシ通信失敗: ${error.message}`); 
        // 外部サーバーとの通信失敗は502 Bad Gateway
        res.status(502).send({ error: `外部サイトへのアクセスに失敗しました: ${error.message}` });
    }
});

// 静的ファイルのルート
app.get('/', (req, res) => {
    // index.htmlは静的ファイルとして配信されることを想定
    res.sendFile(path.join(__dirname, 'index.html'));
});

// サーバー起動
app.listen(PORT, () => {
    console.log(`🚀 プロキシサーバー起動: http://localhost:${PORT}`);
    console.log('クライアントからアクセスして、URLを試してください。');
});
