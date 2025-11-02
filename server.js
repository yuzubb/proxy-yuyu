const express = require('express');
const cors = require('cors');
const path = require('path');
const { URL } = require('url');
const cheerio = require('cheerio');
// fetch APIを使用するため、Node.js 18以降が推奨されます。

const app = express();
const PORT = 3000;

// 💡 改善点3のための追加:
// POSTリクエストのボディ（JSON形式とURLエンコード形式）を解析するためのミドルウェア
app.use(cors()); 
app.use(express.json()); // JSON形式のボディを解析
app.use(express.urlencoded({ extended: true })); // URLエンコード形式のボディを解析
app.use(express.static(__dirname));


/**
 * HTMLコンテンツ内のリソースURLをプロキシURLに書き換える関数
 */
function rewriteHtmlContent(html, originalUrl) {
    const $ = cheerio.load(html);
    const baseUrl = new URL(originalUrl);
    const proxyPrefix = '/proxy?url=';

    // 書き換え対象の要素セレクタを拡張
    const selectors = 'a, form, img, link[rel="stylesheet"], script, [style], video, audio, source, iframe'; 

    $(selectors).each((i, element) => {
        const $element = $(element);
        const tagName = $element.get(0).tagName;
        let attribute = '';
        
        // 1. タグの種類に応じて、書き換え対象の属性を決定 (href/src/action)
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
                const proxiedUrl = proxyPrefix + encodeURIComponent(absoluteUrl);
                
                $element.attr(attribute, proxiedUrl);
                
                if (tagName === 'form') {
                    // formのactionを書き換える際は、methodがない場合にGETを設定
                    $element.attr('method', $element.attr('method') || 'GET');
                }
            } catch (e) {
                // URL変換エラーを無視
            }
        }
        
        // ⭐ 改善点2: srcset属性の書き換え (img, sourceタグ)
        if (tagName === 'img' || tagName === 'source') {
            const srcsetAttr = $element.attr('srcset');
            if (typeof srcsetAttr === 'string' && srcsetAttr.length > 0) {
                const rewrittenSrcset = srcsetAttr.split(',').map(source => {
                    const parts = source.trim().split(/\s+/);
                    const path = parts[0];
                    const descriptor = parts.slice(1).join(' '); // x, wなどの記述子
                    
                    if (path.startsWith('data:')) {
                        return source;
                    }
                    
                    try {
                        const absoluteUrl = new URL(path, baseUrl).href;
                        const proxiedUrl = proxyPrefix + encodeURIComponent(absoluteUrl);
                        return `${proxiedUrl} ${descriptor}`.trim();
                    } catch (e) {
                        return source;
                    }
                }).join(', ');
                
                $element.attr('srcset', rewrittenSrcset);
            }
        }
        
        // 2. インラインスタイル（style属性）内のurl(...)の書き換え
        const styleAttr = $element.attr('style');
        if (typeof styleAttr === 'string' && styleAttr.length > 0) { 
            const rewrittenStyle = styleAttr.replace(/url\s*\((['"]?)(.*?)\1\)/gi, (match, quote, path) => {
                // 絶対URLまたはdata URIはスキップ
                if (path.startsWith('http') || path.startsWith('//') || path.startsWith('data:')) {
                    return match;
                }
                try {
                    const absoluteUrl = new URL(path, baseUrl).href;
                    const proxiedUrl = proxyPrefix + encodeURIComponent(absoluteUrl);
                    return `url(${quote}${proxiedUrl}${quote})`;
                } catch (e) {
                    return match;
                }
            });
            $element.attr('style', rewrittenStyle);
        }
    });

    // baseタグが存在する場合は、相対URLの問題を避けるために削除
    $('base').remove();

    return $.html();
}

// -------------------------------------------------------------
// メインのプロキシエンドポイント (GET/POST/その他のメソッドに対応)
// -------------------------------------------------------------
app.all('/proxy', async (req, res) => { // 💡 app.allで全HTTPメソッドに対応
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

    console.log(`[PROXY] ${req.method} ターゲットURL: ${targetUrl}`);

    try {
        // 💡 改善点1/3: リクエストオプションの準備
        const fetchOptions = {
            method: req.method, // クライアントのメソッドを使用
            signal: AbortSignal.timeout(15000), // 🚨 15秒でタイムアウトを設定
            headers: {
                // 🚨 User-Agentを設定してブラウザとして偽装
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        };

        // POST/PUTなどでボディがある場合、それを転送
        if (req.body && Object.keys(req.body).length > 0) {
            // bodyがJSONとして解析されている場合、文字列に戻して転送
            fetchOptions.body = JSON.stringify(req.body); 
            // Content-Typeヘッダーを転送元から受け継ぐ
            if (req.headers['content-type']) {
                fetchOptions.headers['Content-Type'] = req.headers['content-type'];
            }
        }

        const response = await fetch(targetUrl, fetchOptions);

        res.status(response.status);
        
        const contentType = response.headers.get('content-type');
        
        // ヘッダーを転送
        response.headers.forEach((value, name) => {
            // 転送時に問題を起こすヘッダーは除外
            if (!['connection', 'content-encoding', 'transfer-encoding', 'content-length'].includes(name.toLowerCase())) {
                res.setHeader(name, value);
            }
        });

        if (contentType && contentType.includes('text/html')) {
            // HTMLの場合: URLを書き換え
            const contentBuffer = await response.arrayBuffer();
            let content = Buffer.from(contentBuffer).toString();
            content = rewriteHtmlContent(content, targetUrl);
            res.end(content);
            
        } else if (contentType && contentType.includes('text/css')) {
            // CSSの場合: CSSファイル内のurl(...)を書き換え
            let cssContent = await response.text();
            
            const baseUrl = new URL(targetUrl);
            const proxyPrefix = '/proxy?url=';
            
            // CSS内の url(...) をプロキシURLに書き換える
            cssContent = cssContent.replace(/url\s*\((['"]?)(.*?)\1\)/gi, (match, quote, path) => {
                if (path.startsWith('http') || path.startsWith('//') || path.startsWith('data:')) {
                    return match;
                }
                try {
                    const absoluteUrl = new URL(path, baseUrl).href;
                    const proxiedUrl = proxyPrefix + encodeURIComponent(absoluteUrl);
                    return `url(${quote}${proxiedUrl}${quote})`;
                } catch (e) {
                    return match;
                }
            });
            
            res.end(cssContent);
            
        } else {
            // HTML/CSS以外 (画像、JS、フォントなど) の場合: バイナリとしてそのままレスポンス
            const buffer = await response.arrayBuffer();
            res.end(Buffer.from(buffer));
        }

    } catch (error) {
        // 🚨 改善点1: タイムアウトを含むエラーハンドリング
        let errorMessage = `外部サイトへのアクセスに失敗しました: ${error.message}`;
        let statusCode = 500;
        
        if (error.name === 'TimeoutError' || error.name === 'AbortError') {
            errorMessage = `外部サイトへのアクセスがタイムアウトしました: ${targetUrl}`;
            statusCode = 504; // Gateway Timeout
        }
        
        console.error(`[ERROR] プロキシ通信失敗 (${req.method}): ${errorMessage}`); 
        res.status(statusCode).send({ error: errorMessage });
    }
});

app.get('/', (req, res) => {
    // index.htmlは静的ファイルとして配信されることを想定
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`🚀 プロキシサーバー起動: http://localhost:${PORT}`);
    console.log('クライアントからアクセスして、URLを試してください。');
});
