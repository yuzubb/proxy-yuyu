const express = require('express');
const cors = require('cors');
const path = require('path');
const { URL } = require('url');
const cheerio = require('cheerio');

const app = express();
const PORT = 3000;

app.use(cors()); 
app.use(express.static(__dirname));


/**
 * HTMLコンテンツ内のリソースURLをプロキシURLに書き換える関数
 */
function rewriteHtmlContent(html, originalUrl) {
    const $ = cheerio.load(html);
    const baseUrl = new URL(originalUrl);
    const proxyPrefix = '/proxy?url=';

    // 書き換え対象の要素セレクタを拡張: a, form, img, CSSのlink, script, style属性を持つ全要素、video/audio/iframe/source
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
        
        // ⭐ エラー修正: originalPathが文字列であることを確認 (typeof originalPath === 'string')
        if (typeof originalPath === 'string' && originalPath.length > 0 && !originalPath.startsWith('data:')) {
            try {
                // 相対パスを絶対URLに変換してからプロキシURLに変換
                const absoluteUrl = new URL(originalPath, baseUrl).href;
                const proxiedUrl = proxyPrefix + encodeURIComponent(absoluteUrl);
                
                $element.attr(attribute, proxiedUrl);
                
                if (tagName === 'form') {
                    $element.attr('method', $element.attr('method') || 'GET');
                }
            } catch (e) {
                // URL変換エラーを無視
            }
        }
        
        // 2. インラインスタイル（style属性）内のurl(...)の書き換え
        const styleAttr = $element.attr('style');
        // ⭐ styleAttrも文字列であることを確認
        if (typeof styleAttr === 'string' && styleAttr.length > 0) { 
            const rewrittenStyle = styleAttr.replace(/url\s*\((['"]?)(.*?)\1\)/gi, (match, quote, path) => {
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

    $('base').remove();

    return $.html();
}

// -------------------------------------------------------------
// メインのプロキシエンドポイント
// -------------------------------------------------------------
app.get('/proxy', async (req, res) => {
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
        const response = await fetch(targetUrl, {
            method: 'GET'
        });

        res.status(response.status);
        
        const contentType = response.headers.get('content-type');
        
        response.headers.forEach((value, name) => {
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
        // エラーメッセージを分かりやすくコンソールに出力
        console.error(`[ERROR] プロキシ通信失敗: ${error.message}`); 
        res.status(500).send({ error: `外部サイトへのアクセスに失敗しました: ${error.message}` });
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
