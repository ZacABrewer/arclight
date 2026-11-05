package com.moviemethat.arclight;

import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import androidx.annotation.Nullable;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;
import java.io.ByteArrayInputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;

/**
 * Artwork on a plain-http server. The page is https://localhost, and Android's WebView blocks http
 * images there as mixed content (fetch gets through, so lists load and only the pictures go
 * missing). The page asks for {@code /_arclight/art?src=<signed artwork URL>} instead (core/api.ts
 * appArtworkUrl) and this fetches the image natively. Only artwork URLs are fetched; they carry
 * their own signature, so no credentials are added here.
 */
public class ArtworkProxy extends BridgeWebViewClient {

    static final String PATH = "/_arclight/art";
    private static final String ARTWORK_PATH = "/api/v1/playback/artwork/";
    private static final int MAX_REDIRECTS = 5;
    private static final int TIMEOUT_MS = 15_000;

    public ArtworkProxy(Bridge bridge) {
        super(bridge);
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        Uri url = request.getUrl();
        if ("localhost".equals(url.getHost()) && PATH.equals(url.getPath()) && "GET".equals(request.getMethod())) {
            return fetch(url.getQueryParameter("src"));
        }
        return super.shouldInterceptRequest(view, request);
    }

    /** True for an http(s) URL of a server's artwork route. */
    static boolean allowed(@Nullable String src) {
        if (src == null) return false;
        Uri u = Uri.parse(src);
        String scheme = u.getScheme();
        String path = u.getPath();
        return ("http".equals(scheme) || "https".equals(scheme)) && u.getHost() != null && path != null && path.contains(ARTWORK_PATH);
    }

    private static WebResourceResponse fetch(@Nullable String src) {
        if (!allowed(src)) return status(400, "Bad Request");
        try {
            URL next = new URL(src);
            // HttpURLConnection does not follow http → https (the server's 302 to a remote poster).
            for (int hop = 0; hop <= MAX_REDIRECTS; hop++) {
                HttpURLConnection c = (HttpURLConnection) next.openConnection();
                c.setInstanceFollowRedirects(false);
                c.setConnectTimeout(TIMEOUT_MS);
                c.setReadTimeout(TIMEOUT_MS);
                int code = c.getResponseCode();
                if (code >= 300 && code < 400 && c.getHeaderField("Location") != null) {
                    URL to = new URL(next, c.getHeaderField("Location"));
                    c.disconnect();
                    if (!"http".equals(to.getProtocol()) && !"https".equals(to.getProtocol())) return status(502, "Bad Gateway");
                    next = to;
                    continue;
                }
                if (code < 200 || code >= 300) {
                    c.disconnect();
                    return status(code, "Error");
                }
                String type = c.getContentType();
                String mime = type == null ? "application/octet-stream" : type.split(";")[0].trim();
                Map<String, String> headers = new HashMap<>();
                String cache = c.getHeaderField("Cache-Control");
                headers.put("Cache-Control", cache != null ? cache : "private, max-age=86400");
                InputStream body = new FilterInputStream(c.getInputStream()) {
                    @Override
                    public void close() throws IOException {
                        try {
                            super.close();
                        } finally {
                            c.disconnect();
                        }
                    }
                };
                return new WebResourceResponse(mime, null, code, "OK", headers, body);
            }
            return status(508, "Too Many Redirects");
        } catch (IOException | RuntimeException e) {
            return status(502, "Bad Gateway");
        }
    }

    private static WebResourceResponse status(int code, String reason) {
        return new WebResourceResponse("text/plain", "utf-8", code, reason, Collections.emptyMap(),
                new ByteArrayInputStream(reason.getBytes(StandardCharsets.UTF_8)));
    }
}
