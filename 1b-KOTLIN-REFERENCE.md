# 1b — Kotlin রেফারেন্স কোড (AI Studio-তে সংযুক্ত করুন) — v11.2

এটি একটি তৈরি, পূর্ণ Android WebView প্রজেক্টের কোড। প্রম্পটের নির্দেশমতো এটি হুবহু ব্যবহার করো।
নোঙর অ্যালার্মের শব্দ: `app/src/main/res/raw/anchor_alarm.mp3` (বাইনারি ফাইল — আলাদাভাবে সংযুক্ত করুন; ওয়েব ফোল্ডারেও `anchor-alarm.mp3` আছে)।

## `app/src/main/java/com/stms/trawler/MainActivity.kt`

```kotlin
package com.stms.trawler

import android.Manifest
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.provider.Settings
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.graphics.Color
import androidx.core.view.WindowInsetsControllerCompat
import android.util.Base64
import android.view.View
import android.view.WindowManager
import android.webkit.GeolocationPermissions
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.credentials.ClearCredentialStateRequest
import androidx.credentials.CredentialManager
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.lifecycle.lifecycleScope
import androidx.webkit.WebViewAssetLoader
import com.google.android.libraries.identity.googleid.GetGoogleIdOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.File

class MainActivity : AppCompatActivity() {

    companion object {
        /** অবস্থান শেয়ার চালু থাকলে অ্যাপ ব্যাকগ্রাউন্ডে গেলেও WebView-র JS চলতে দেয় */
        @Volatile var keepWebAlive = false
    }

    private lateinit var web: WebView
    private lateinit var assetLoader: WebViewAssetLoader
    private lateinit var credentialManager: CredentialManager
    private val prefs by lazy { getSharedPreferences("stms", MODE_PRIVATE) }

    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var cameraUri: Uri? = null
    private var pendingWebRequest: PermissionRequest? = null
    private var pendingGeo: Pair<String, GeolocationPermissions.Callback>? = null
    private var pendingId: String? = null
    private var lastBack = 0L

    private val home = "https://appassets.androidplatform.net/assets/web/index.html"

    // ---------- অনুমতি ----------
    private fun permsFor(id: String): List<String> = when (id) {
        "microphone" -> listOf(Manifest.permission.RECORD_AUDIO)
        "geolocation" -> listOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
        "camera" -> listOf(Manifest.permission.CAMERA)
        "notifications" -> if (Build.VERSION.SDK_INT >= 33) listOf(Manifest.permission.POST_NOTIFICATIONS) else emptyList()
        "storage" -> if (Build.VERSION.SDK_INT >= 33) listOf(Manifest.permission.READ_MEDIA_IMAGES)
        else if (Build.VERSION.SDK_INT >= 29) emptyList() else listOf(Manifest.permission.WRITE_EXTERNAL_STORAGE)
        else -> emptyList()   // compass: কোনো অনুমতি লাগে না
    }

    private fun granted(p: String) = ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED
    private fun allGranted(id: String): Boolean {
        val l = permsFor(id)
        if (l.isEmpty()) return true
        // লোকেশনে fine অথবা coarse একটি থাকলেই চলে
        return if (id == "geolocation") l.any { granted(it) } else l.all { granted(it) }
    }

    private val permLauncher = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        val id = pendingId
        if (id != null) prefs.edit().putBoolean("asked_$id", true).apply()
        pendingWebRequest?.let { r ->
            val ok = r.resources.all { res ->
                when (res) {
                    PermissionRequest.RESOURCE_AUDIO_CAPTURE -> granted(Manifest.permission.RECORD_AUDIO)
                    PermissionRequest.RESOURCE_VIDEO_CAPTURE -> granted(Manifest.permission.CAMERA)
                    else -> true
                }
            }
            if (ok) r.grant(r.resources) else r.deny()
            pendingWebRequest = null
        }
        pendingGeo?.let { (origin, cb) -> cb.invoke(origin, allGranted("geolocation"), false); pendingGeo = null }
        js("window.onNativePerm&&onNativePerm()")
    }

    private fun ask(id: String) {
        val l = permsFor(id).filter { !granted(it) }
        if (l.isEmpty()) { js("window.onNativePerm&&onNativePerm()"); return }
        pendingId = id
        permLauncher.launch(l.toTypedArray())
    }

    private fun askAllFirstRun() {
        if (prefs.getBoolean("first_run_done", false)) return
        prefs.edit().putBoolean("first_run_done", true).apply()
        val all = listOf("microphone", "geolocation", "camera", "notifications", "storage")
            .flatMap { permsFor(it) }.distinct().filter { !granted(it) }
        if (all.isNotEmpty()) {
            pendingId = null
            permLauncher.launch(all.toTypedArray())
        }
    }

    // ---------- ফাইল বাছাই / ক্যামেরা ----------
    private val fileLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { res ->
        val cb = fileCallback ?: return@registerForActivityResult
        fileCallback = null
        var out: Array<Uri>? = null
        if (res.resultCode == Activity.RESULT_OK) {
            val data = res.data
            out = when {
                data?.clipData != null -> Array(data.clipData!!.itemCount) { data.clipData!!.getItemAt(it).uri }
                data?.data != null -> arrayOf(data.data!!)
                cameraUri != null -> arrayOf(cameraUri!!)
                else -> null
            }
        }
        cb.onReceiveValue(out)
        cameraUri = null
    }

    // ---------- জাভাস্ক্রিপ্ট সেতু ----------
    inner class Bridge {
        @JavascriptInterface fun googleSignIn() { runOnUiThread { nativeGoogleSignIn() } }
        @JavascriptInterface fun googleSignOut() {
            lifecycleScope.launch { try { credentialManager.clearCredentialState(ClearCredentialStateRequest()) } catch (_: Exception) {} }
        }
        @JavascriptInterface fun exitApp() { runOnUiThread { finishAffinity() } }
        @JavascriptInterface fun permState(id: String): String {
            if (allGranted(id)) return "granted"
            val asked = prefs.getBoolean("asked_$id", false)
            val rationale = permsFor(id).any { ActivityCompat.shouldShowRequestPermissionRationale(this@MainActivity, it) }
            return if (asked && !rationale) "denied" else "prompt"
        }
        @JavascriptInterface fun requestPerm(id: String) {
            runOnUiThread {
                if (permState(id) == "denied") {
                    startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null)))
                } else ask(id)
            }
        }
        @JavascriptInterface fun saveFile(base64: String, name: String, mime: String) { saveToDownloads(base64, name, mime) }
        @JavascriptInterface fun keepScreenOn(on: Boolean) {
            runOnUiThread {
                if (on) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
        }
        @JavascriptInterface fun appVersion(): String = "1.0"
        @JavascriptInterface fun getAppVersion(): String = "1.0"
        @JavascriptInterface fun saveBase64(b64: String, fileName: String, mime: String) { saveToDownloads(b64, fileName, mime) }
        @JavascriptInterface fun shareText(title: String, text: String) {
            runOnUiThread {
                val i = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_SUBJECT, title).putExtra(Intent.EXTRA_TEXT, text)
                startActivity(Intent.createChooser(i, title.ifBlank { "শেয়ার" }))
            }
        }
        @JavascriptInterface fun setStatusBarColor(hex: String) {
            runOnUiThread {
                try {
                    val c = Color.parseColor(hex)
                    window.statusBarColor = c
                    val lum = (0.299 * Color.red(c) + 0.587 * Color.green(c) + 0.114 * Color.blue(c)) / 255.0
                    WindowInsetsControllerCompat(window, window.decorView).isAppearanceLightStatusBars = lum > 0.6
                } catch (_: Exception) {}
            }
        }
        @JavascriptInterface fun startSpeech(lang: String) { runOnUiThread { startSpeechNative(lang) } }
        @JavascriptInterface fun stopSpeech() { runOnUiThread { try { recognizer?.stopListening() } catch (_: Exception) {} } }

        // ---- নোঙর অ্যালার্ম (ব্যাকগ্রাউন্ড সার্ভিস) ----
        @JavascriptInterface fun anchorStart(lat: Double, lon: Double, r: Double) {
            runOnUiThread {
                val i = Intent(this@MainActivity, AnchorService::class.java).setAction(AnchorService.A_START)
                    .putExtra("lat", lat).putExtra("lon", lon).putExtra("r", r)
                ContextCompat.startForegroundService(this@MainActivity, i)
            }
        }
        @JavascriptInterface fun anchorStop() {
            runOnUiThread { startService(Intent(this@MainActivity, AnchorService::class.java).setAction(AnchorService.A_STOP)) }
        }
        @JavascriptInterface fun anchorState(): String = AnchorService.state(this@MainActivity)
        // ---- 📡 ট্রলার রাডার: অবস্থান শেয়ার ব্যাকগ্রাউন্ডে চালু রাখা ----
        @JavascriptInterface fun trackStart() {
            runOnUiThread {
                keepWebAlive = true
                ContextCompat.startForegroundService(this@MainActivity, Intent(this@MainActivity, TrackService::class.java).setAction(TrackService.A_START))
            }
        }
        @JavascriptInterface fun trackStop() {
            runOnUiThread {
                keepWebAlive = false
                startService(Intent(this@MainActivity, TrackService::class.java).setAction(TrackService.A_STOP))
            }
        }
        @JavascriptInterface fun alarmStart() { AlarmPlayer.start(this@MainActivity) }
        @JavascriptInterface fun alarmStop() {
            AlarmPlayer.stop(this@MainActivity)
            runOnUiThread {
                if (JSONObject(AnchorService.state(this@MainActivity)).optBoolean("active"))
                    startService(Intent(this@MainActivity, AnchorService::class.java).setAction(AnchorService.A_MUTE))
            }
        }
        /** ব্যাটারি অপটিমাইজেশন তালিকা খোলে — অ্যাপকে "সীমাহীন" করলে ব্যাকগ্রাউন্ডে নির্ভরযোগ্য চলে */
        @JavascriptInterface fun batterySettings() {
            runOnUiThread { try { startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) } catch (_: Exception) {} }
        }
    }

    private fun js(code: String) { web.post { web.evaluateJavascript(code, null) } }

    private fun nativeGoogleSignIn() {
        lifecycleScope.launch {
            try {
                val opt = GetGoogleIdOption.Builder()
                    .setFilterByAuthorizedAccounts(false)
                    .setServerClientId(getString(R.string.default_web_client_id))
                    .setAutoSelectEnabled(false)
                    .build()
                val req = GetCredentialRequest.Builder().addCredentialOption(opt).build()
                val res = credentialManager.getCredential(this@MainActivity, req)
                val c = res.credential
                if (c is CustomCredential && c.type == GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL) {
                    val token = GoogleIdTokenCredential.createFrom(c.data).idToken
                    js("window.onNativeGoogleToken&&onNativeGoogleToken(${JSONObject.quote(token)})")
                } else {
                    js("window.onNativeGoogleError&&onNativeGoogleError('Google অ্যাকাউন্ট পাওয়া যায়নি',false)")
                }
            } catch (e: GetCredentialCancellationException) {
                js("window.onNativeGoogleError&&onNativeGoogleError('',true)")
            } catch (e: Exception) {
                js("window.onNativeGoogleError&&onNativeGoogleError(${JSONObject.quote(e.message ?: "Google সাইন ইন হয়নি")},false)")
            }
        }
    }

    // ---------- বাংলা ভয়েস (SpeechRecognizer) ----------
    private var recognizer: SpeechRecognizer? = null

    private fun startSpeechNative(lang: String) {
        if (!granted(Manifest.permission.RECORD_AUDIO)) {
            ask("microphone")
            js("window.onNativeSpeechEnd&&onNativeSpeechEnd('মাইক্রোফোনের অনুমতি দিন, তারপর আবার চাপুন')")
            return
        }
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            js("window.onNativeSpeechEnd&&onNativeSpeechEnd('এই ফোনে ভয়েস চেনার সুবিধা নেই (Google অ্যাপ আপডেট করুন)')")
            return
        }
        try { recognizer?.destroy() } catch (_: Exception) {}
        val r = SpeechRecognizer.createSpeechRecognizer(this)
        recognizer = r
        r.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(p: Bundle?) {}
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(v: Float) {}
            override fun onBufferReceived(b: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onEvent(t: Int, p: Bundle?) {}
            override fun onPartialResults(b: Bundle?) {
                val x = b?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull() ?: return
                js("window.onNativeSpeech&&onNativeSpeech(${JSONObject.quote(x)},false)")
            }
            override fun onResults(b: Bundle?) {
                val x = b?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull() ?: ""
                js("window.onNativeSpeech&&onNativeSpeech(${JSONObject.quote(x)},true)")
                js("window.onNativeSpeechEnd&&onNativeSpeechEnd('')")
            }
            override fun onError(e: Int) {
                val msg = when (e) {
                    SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> ""
                    SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "ইন্টারনেট লাগবে"
                    SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "মাইক্রোফোনের অনুমতি নেই"
                    else -> "ভয়েস ত্রুটি ($e)"
                }
                js("window.onNativeSpeechEnd&&onNativeSpeechEnd(${JSONObject.quote(msg)})")
            }
        })
        val i = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang.ifBlank { "bn-BD" })
            .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
        r.startListening(i)
    }

    // ---------- ডাউনলোড (Excel, ব্যাকআপ, ইনভয়েস ছবি) ----------
    private fun saveToDownloads(base64: String, name: String, mime: String) {
        try {
            val bytes = Base64.decode(base64, Base64.DEFAULT)
            val safe = name.replace(Regex("[\\\\/:*?\"<>|]"), "_")
            if (Build.VERSION.SDK_INT >= 29) {
                val v = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, safe)
                    put(MediaStore.Downloads.MIME_TYPE, mime)
                    put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
                }
                val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v)!!
                contentResolver.openOutputStream(uri)!!.use { it.write(bytes) }
            } else {
                val dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
                dir.mkdirs()
                File(dir, safe).writeBytes(bytes)
            }
            runOnUiThread { Toast.makeText(this, "ডাউনলোডে সেভ হয়েছে: $safe", Toast.LENGTH_LONG).show() }
        } catch (e: Exception) {
            runOnUiThread { Toast.makeText(this, "ফাইল সেভ হয়নি: ${e.message}", Toast.LENGTH_LONG).show() }
        }
    }

    private val downloadShim = """
        (function(){if(window.__dlShim)return;window.__dlShim=1;var o=HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click=function(){
          var h=this.href||'',n=this.download;
          if(n!==undefined&&n!==null&&(h.indexOf('blob:')===0||h.indexOf('data:')===0)&&window.AndroidAppBridge){
            var name=n||'file';
            fetch(h).then(function(r){return r.blob()}).then(function(b){var fr=new FileReader();fr.onload=function(){var d=String(fr.result);AndroidAppBridge.saveFile(d.substring(d.indexOf(',')+1),name,b.type||'application/octet-stream')};fr.readAsDataURL(b)});
            return;
          }
          return o.apply(this,arguments)};})();
    """.trimIndent()

    // ---------- জীবনচক্র ----------
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= 27) { setShowWhenLocked(true); setTurnScreenOn(true) }
        credentialManager = CredentialManager.create(this)
        assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        web = WebView(this)
        web.setBackgroundColor(0xFF075985.toInt())
        setContentView(web)
        web.fitsSystemWindows = true
        web.setLayerType(View.LAYER_TYPE_HARDWARE, null)
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = true
            setGeolocationEnabled(true)
            cacheMode = WebSettings.LOAD_DEFAULT
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            userAgentString = userAgentString + " STMSApp/1.0"
            textZoom = 100
        }
        web.addJavascriptInterface(Bridge(), "AndroidAppBridge")

        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                assetLoader.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val u = request.url
                if (u.host == "appassets.androidplatform.net") return false
                return try { startActivity(Intent(Intent.ACTION_VIEW, u)); true } catch (e: ActivityNotFoundException) { true }
            }

            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                view.evaluateJavascript(downloadShim, null)
            }
            override fun onPageFinished(view: WebView, url: String?) {
                view.evaluateJavascript(downloadShim, null)
            }
        }

        web.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread {
                    val need = mutableListOf<String>()
                    request.resources.forEach {
                        if (it == PermissionRequest.RESOURCE_AUDIO_CAPTURE && !granted(Manifest.permission.RECORD_AUDIO)) need += Manifest.permission.RECORD_AUDIO
                        if (it == PermissionRequest.RESOURCE_VIDEO_CAPTURE && !granted(Manifest.permission.CAMERA)) need += Manifest.permission.CAMERA
                    }
                    if (need.isEmpty()) request.grant(request.resources)
                    else { pendingWebRequest = request; pendingId = null; permLauncher.launch(need.toTypedArray()) }
                }
            }

            override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) {
                runOnUiThread {
                    if (allGranted("geolocation")) callback.invoke(origin, true, false)
                    else { pendingGeo = origin to callback; pendingId = "geolocation"; permLauncher.launch(permsFor("geolocation").toTypedArray()) }
                }
            }

            override fun onShowFileChooser(view: WebView, cb: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = cb
                val wantsImage = params.acceptTypes.any { it.startsWith("image") }
                return try {
                    if (params.isCaptureEnabled && wantsImage && granted(Manifest.permission.CAMERA)) {
                        val f = File(File(cacheDir, "images").apply { mkdirs() }, "cap_${System.currentTimeMillis()}.jpg")
                        cameraUri = FileProvider.getUriForFile(this@MainActivity, "$packageName.fileprovider", f)
                        val i = Intent(MediaStore.ACTION_IMAGE_CAPTURE).putExtra(MediaStore.EXTRA_OUTPUT, cameraUri)
                        fileLauncher.launch(i)
                    } else {
                        if (params.isCaptureEnabled && wantsImage) ask("camera")
                        fileLauncher.launch(params.createIntent())
                    }
                    true
                } catch (e: Exception) {
                    fileCallback = null
                    false
                }
            }
        }

        // ফোনের ব্যাক বাটন: ওয়েব ইতিহাসে পেছনে যায় (মডাল/পাতা বন্ধ করে), শেষে বের হয়
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                web.evaluateJavascript("(window.onAndroidBack&&window.onAndroidBack())") { r ->
                    if (r == "true") return@evaluateJavascript
                    val now = System.currentTimeMillis()
                    if (now - lastBack < 2000) finish()
                    else { lastBack = now; Toast.makeText(this@MainActivity, "আবার চাপলে বের হবে", Toast.LENGTH_SHORT).show() }
                }
            }
        })

        setMaxRefreshRate()
        if (savedInstanceState == null) web.loadUrl(home) else web.restoreState(savedInstanceState)
        askAllFirstRun()
    }

    /** ডিসপ্লের সর্বোচ্চ রিফ্রেশ রেট (৯০/১২০ Hz) চালু করে */
    @Suppress("DEPRECATION")
    private fun setMaxRefreshRate() {
        try {
            val d = windowManager.defaultDisplay
            val cur = d.mode
            val best = d.supportedModes
                .filter { it.physicalWidth == cur.physicalWidth && it.physicalHeight == cur.physicalHeight }
                .maxByOrNull { it.refreshRate } ?: return
            val lp = window.attributes
            lp.preferredDisplayModeId = best.modeId
            if (Build.VERSION.SDK_INT >= 30) lp.preferredRefreshRate = best.refreshRate
            window.attributes = lp
        } catch (_: Exception) {}
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    override fun onResume() { super.onResume(); web.onResume(); setMaxRefreshRate() }
    override fun onPause() { if (keepWebAlive) web.resumeTimers() else web.onPause(); super.onPause() }
    override fun onDestroy() { try { recognizer?.destroy() } catch (_: Exception) {}; web.destroy(); super.onDestroy() }
}
```

## `app/src/main/java/com/stms/trawler/AnchorService.kt`

```kotlin
package com.stms.trawler

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.VibrationEffect
import android.os.Vibrator
import androidx.core.app.NotificationCompat
import org.json.JSONObject

/** জোরালো অ্যালার্ম শব্দ ও কাঁপুনি (অ্যাপ বা সার্ভিস — যেখান থেকেই ডাকা হোক) */
object AlarmPlayer {
    private var player: MediaPlayer? = null
    private var wake: PowerManager.WakeLock? = null
    @Volatile var playing = false

    @Suppress("DEPRECATION")
    fun start(ctx: Context) {
        if (playing) return
        playing = true
        try {
            val am = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
            am.setStreamVolume(AudioManager.STREAM_ALARM, am.getStreamMaxVolume(AudioManager.STREAM_ALARM), 0)
            val mp = MediaPlayer()
            // আপলোড করা অ্যালার্ম অডিও (res/raw/anchor_alarm.mp3); না পেলে ফোনের ডিফল্ট অ্যালার্ম
            try {
                ctx.resources.openRawResourceFd(R.raw.anchor_alarm).use { afd ->
                    mp.setDataSource(afd.fileDescriptor, afd.startOffset, afd.length)
                }
            } catch (_: Exception) {
                mp.reset()
                val uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
                    ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
                mp.setDataSource(ctx, uri)
            }
            mp.setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ALARM)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build()
            )
            mp.isLooping = true
            mp.setVolume(1f, 1f)
            mp.prepare()
            mp.start()
            player = mp
        } catch (_: Exception) {}
        try {
            val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
            wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "stms:alarm").apply { acquire(10 * 60 * 1000L) }
        } catch (_: Exception) {}
        try {
            val v = ctx.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
            val pattern = longArrayOf(0, 800, 250, 800, 250, 800, 900)
            if (Build.VERSION.SDK_INT >= 26) v.vibrate(VibrationEffect.createWaveform(pattern, 0))
            else v.vibrate(pattern, 0)
        } catch (_: Exception) {}
    }

    @Suppress("DEPRECATION")
    fun stop(ctx: Context) {
        playing = false
        try { player?.stop() } catch (_: Exception) {}
        try { player?.release() } catch (_: Exception) {}
        player = null
        try { (ctx.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator).cancel() } catch (_: Exception) {}
        try { wake?.let { if (it.isHeld) it.release() } } catch (_: Exception) {}
        wake = null
    }
}

/**
 * নোঙর পাহারা: ফোন লক থাকলে বা অ্যাপ ব্যাকগ্রাউন্ডে গেলেও GPS দেখে।
 * নোঙর থেকে সীমার বাইরে গেলে সর্বোচ্চ ভলিউমে অ্যালার্ম + কাঁপুনি + পূর্ণ স্ক্রিন নোটিফিকেশন।
 */
class AnchorService : Service() {

    companion object {
        const val A_START = "stms.anchor.start"
        const val A_STOP = "stms.anchor.stop"
        const val A_MUTE = "stms.anchor.mute"
        private const val CH_WATCH = "anchor_watch"
        private const val CH_ALARM = "anchor_alarm_v2" // নতুন আইডি: পুরোনো চ্যানেলের ডিফল্ট শব্দ বাদ
        private const val ID_WATCH = 4101
        private const val ID_ALARM = 4102

        fun state(ctx: Context): String =
            ctx.getSharedPreferences("stms", Context.MODE_PRIVATE).getString("anchor_state", "{\"active\":false}") ?: "{\"active\":false}"

        fun saveState(ctx: Context, active: Boolean, alarm: Boolean, dist: Double, lat: Double, lon: Double, r: Double) {
            val j = JSONObject().put("active", active).put("alarm", alarm).put("dist", dist).put("lat", lat).put("lon", lon).put("r", r)
            ctx.getSharedPreferences("stms", Context.MODE_PRIVATE).edit().putString("anchor_state", j.toString()).apply()
        }
    }

    private var lm: LocationManager? = null
    private var lat = 0.0
    private var lon = 0.0
    private var radius = 100.0
    private var outCount = 0
    private var mutedUntil = 0L
    private var alarming = false
    private var lastDist = 0.0
    private val handler = Handler(Looper.getMainLooper())

    private val listener = LocationListener { loc -> onFix(loc) }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            A_START -> {
                lat = intent.getDoubleExtra("lat", 0.0)
                lon = intent.getDoubleExtra("lon", 0.0)
                radius = intent.getDoubleExtra("r", 100.0)
                outCount = 0; mutedUntil = 0L; alarming = false
                goForeground()
                startUpdates()
                saveState(this, true, false, 0.0, lat, lon, radius)
            }
            A_MUTE -> mute()
            A_STOP -> { stopAll(); return START_NOT_STICKY }
            else -> {
                // সিস্টেম সার্ভিস আবার চালু করলে আগের অবস্থা ফিরিয়ে আনা
                val st = try { JSONObject(state(this)) } catch (_: Exception) { JSONObject() }
                if (st.optBoolean("active")) {
                    lat = st.optDouble("lat"); lon = st.optDouble("lon"); radius = st.optDouble("r", 100.0)
                    goForeground(); startUpdates()
                } else { stopSelf(); return START_NOT_STICKY }
            }
        }
        return START_STICKY
    }

    private fun channels() {
        if (Build.VERSION.SDK_INT < 26) return
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CH_WATCH, "নোঙর পাহারা", NotificationManager.IMPORTANCE_LOW))
        val ch = NotificationChannel(CH_ALARM, "নোঙর অ্যালার্ম", NotificationManager.IMPORTANCE_HIGH)
        ch.enableVibration(true); ch.setBypassDnd(true)
        ch.setSound(null, null) // শব্দ বাজায় AlarmPlayer (anchor_alarm.mp3) — নোটিফিকেশনের ডিফল্ট শব্দ নয়
        nm.createNotificationChannel(ch)
    }

    private fun openApp(): PendingIntent {
        val i = Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        return PendingIntent.getActivity(this, 1, i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    private fun act(action: String, code: Int): PendingIntent {
        val i = Intent(this, AnchorService::class.java).setAction(action)
        return PendingIntent.getService(this, code, i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    private fun watchNotification(text: String): Notification =
        NotificationCompat.Builder(this, CH_WATCH)
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentTitle("⚓ নোঙর পাহারা চালু")
            .setContentText(text)
            .setOngoing(true)
            .setContentIntent(openApp())
            .addAction(0, "অ্যালার্ম বন্ধ", act(A_STOP, 11))
            .build()

    private fun goForeground() {
        channels()
        val n = watchNotification("সীমা ${radius.toInt()} মিটার — ফোন লক থাকলেও পাহারা চলবে")
        if (Build.VERSION.SDK_INT >= 29) startForeground(ID_WATCH, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
        else startForeground(ID_WATCH, n)
    }

    private fun startUpdates() {
        val m = getSystemService(Context.LOCATION_SERVICE) as LocationManager
        lm = m
        try { m.removeUpdates(listener) } catch (_: Exception) {}
        try { m.requestLocationUpdates(LocationManager.GPS_PROVIDER, 2000L, 0f, listener, Looper.getMainLooper()) } catch (_: SecurityException) {} catch (_: Exception) {}
        try { m.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 5000L, 0f, listener, Looper.getMainLooper()) } catch (_: Exception) {}
    }

    private fun onFix(loc: Location) {
        val d = FloatArray(1)
        Location.distanceBetween(lat, lon, loc.latitude, loc.longitude, d)
        val dist = d[0].toDouble()
        lastDist = dist
        val eff = dist - (if (loc.hasAccuracy()) loc.accuracy * 0.5 else 0.0)
        if (eff > radius) {
            outCount++
            if (outCount >= 2 && System.currentTimeMillis() > mutedUntil && !alarming) startAlarm(dist)
        } else {
            outCount = 0
            if (alarming) stopAlarm()
        }
        saveState(this, true, alarming, dist, lat, lon, radius)
    }

    private fun startAlarm(dist: Double) {
        alarming = true
        AlarmPlayer.start(this)
        val n = NotificationCompat.Builder(this, CH_ALARM)
            .setSmallIcon(android.R.drawable.ic_dialog_alert)
            .setContentTitle("🚨 নোঙর সরে গেছে!")
            .setContentText("নোঙর থেকে ${dist.toInt()} মিটার দূরে (সীমা ${radius.toInt()} মি)")
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setOngoing(true)
            .setFullScreenIntent(openApp(), true)
            .setContentIntent(openApp())
            .addAction(0, "১ মিনিট চুপ", act(A_MUTE, 12))
            .addAction(0, "অ্যালার্ম বন্ধ", act(A_STOP, 11))
            .build()
        getSystemService(NotificationManager::class.java).notify(ID_ALARM, n)
        try {
            startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP))
        } catch (_: Exception) {}
    }

    private fun stopAlarm() {
        alarming = false
        AlarmPlayer.stop(this)
        getSystemService(NotificationManager::class.java).cancel(ID_ALARM)
    }

    private fun mute() {
        mutedUntil = System.currentTimeMillis() + 60_000L
        outCount = 0
        stopAlarm()
        saveState(this, true, false, lastDist, lat, lon, radius)
    }

    private fun stopAll() {
        try { lm?.removeUpdates(listener) } catch (_: Exception) {}
        stopAlarm()
        saveState(this, false, false, 0.0, lat, lon, radius)
        stopForeground(true)
        stopSelf()
    }

    override fun onDestroy() {
        try { lm?.removeUpdates(listener) } catch (_: Exception) {}
        AlarmPlayer.stop(this)
        super.onDestroy()
    }
}
```

## `app/src/main/java/com/stms/trawler/TrackService.kt`

```kotlin
package com.stms.trawler

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import androidx.core.app.NotificationCompat

/**
 * 📡 অবস্থান শেয়ার চালু থাকলে অ্যাপকে ব্যাকগ্রাউন্ডে বাঁচিয়ে রাখে।
 * WebView-র ভেতরের JS (Firebase-এ অবস্থান লেখা) ফোন লক থাকলেও চলতে পারে — এজন্য
 * ফোরগ্রাউন্ড নোটিফিকেশন + GPS অ্যাক্সেস + CPU wake lock ধরে রাখে।
 */
class TrackService : Service() {

    companion object {
        const val A_START = "stms.track.start"
        const val A_STOP = "stms.track.stop"
        private const val CH = "track_share"
        private const val ID = 4201
    }

    private var lm: LocationManager? = null
    private var wake: PowerManager.WakeLock? = null
    private val listener = LocationListener { }   // GPS সচল রাখার জন্য; আসল ব্যবহার ওয়েব অংশে

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == A_STOP) { stopAll(); return START_NOT_STICKY }
        startForegroundNow()
        try {
            val m = getSystemService(Context.LOCATION_SERVICE) as LocationManager
            lm = m
            m.removeUpdates(listener)
            m.requestLocationUpdates(LocationManager.GPS_PROVIDER, 5000L, 0f, listener, Looper.getMainLooper())
        } catch (_: Exception) {}
        try {
            if (wake == null) {
                val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
                wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "stms:track").apply { acquire(12 * 60 * 60 * 1000L) }
            }
        } catch (_: Exception) {}
        return START_STICKY
    }

    private fun startForegroundNow() {
        if (Build.VERSION.SDK_INT >= 26) {
            getSystemService(NotificationManager::class.java)
                .createNotificationChannel(NotificationChannel(CH, "অবস্থান শেয়ার", NotificationManager.IMPORTANCE_LOW))
        }
        val open = PendingIntent.getActivity(
            this, 2, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val stop = PendingIntent.getService(
            this, 3, Intent(this, TrackService::class.java).setAction(A_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val n: Notification = NotificationCompat.Builder(this, CH)
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentTitle("📡 অবস্থান শেয়ার চলছে")
            .setContentText("আপনার ট্র্যাকিং কোড যাদের কাছে আছে তারা আপনাকে রাডারে দেখছে")
            .setOngoing(true)
            .setContentIntent(open)
            .addAction(0, "বন্ধ", stop)
            .build()
        if (Build.VERSION.SDK_INT >= 29) startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
        else startForeground(ID, n)
    }

    private fun stopAll() {
        try { lm?.removeUpdates(listener) } catch (_: Exception) {}
        try { wake?.let { if (it.isHeld) it.release() } } catch (_: Exception) {}
        wake = null
        MainActivity.keepWebAlive = false
        stopForeground(true)
        stopSelf()
    }

    override fun onDestroy() {
        try { lm?.removeUpdates(listener) } catch (_: Exception) {}
        try { wake?.let { if (it.isHeld) it.release() } } catch (_: Exception) {}
        super.onDestroy()
    }
}
```

## `app/src/main/AndroidManifest.xml`

```xml
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <!-- নেটওয়ার্ক -->
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />

    <!-- লোকেশন (GPS, কম্পাস, আবহাওয়া, নোঙর অ্যালার্ম) -->
    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
    <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />

    <!-- ক্যামেরা ও মাইক্রোফোন (রসিদ স্ক্যান, ভয়েস এন্ট্রি) -->
    <uses-permission android:name="android.permission.CAMERA" />
    <uses-permission android:name="android.permission.RECORD_AUDIO" />
    <uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />

    <!-- স্টোরেজ / ছবি / ফাইল -->
    <uses-permission android:name="android.permission.READ_MEDIA_IMAGES" />
    <uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />
    <uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="28" />

    <!-- নোটিফিকেশন, কাঁপুনি, স্ক্রিন জাগিয়ে রাখা, কম্পাস সেন্সর -->
    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
    <uses-permission android:name="android.permission.VIBRATE" />
    <uses-permission android:name="android.permission.WAKE_LOCK" />
    <uses-permission android:name="android.permission.HIGH_SAMPLING_RATE_SENSORS" />

    <!-- নোঙর অ্যালার্ম: ব্যাকগ্রাউন্ড পাহারা, পূর্ণ স্ক্রিন সতর্কতা -->
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_LOCATION" />
    <uses-permission android:name="android.permission.USE_FULL_SCREEN_INTENT" />

    <uses-feature android:name="android.hardware.camera" android:required="false" />
    <uses-feature android:name="android.hardware.location.gps" android:required="false" />
    <uses-feature android:name="android.hardware.microphone" android:required="false" />
    <uses-feature android:name="android.hardware.sensor.compass" android:required="false" />

    <queries>
        <intent><action android:name="android.intent.action.VIEW" /><data android:scheme="https" /></intent>
        <intent><action android:name="android.intent.action.VIEW" /><data android:scheme="whatsapp" /></intent>
        <intent><action android:name="android.intent.action.VIEW" /><data android:scheme="tel" /></intent>
        <intent><action android:name="android.intent.action.VIEW" /><data android:scheme="mailto" /></intent>
    </queries>

    <application
        android:allowBackup="true"
        android:hardwareAccelerated="true"
        android:icon="@mipmap/ic_launcher"
        android:roundIcon="@mipmap/ic_launcher"
        android:label="@string/app_name"
        android:supportsRtl="true"
        android:usesCleartextTraffic="false"
        android:theme="@style/Theme.STMS">

        <activity
            android:name=".MainActivity"
            android:exported="true"
            android:configChanges="orientation|screenSize|keyboardHidden|smallestScreenSize|screenLayout|uiMode|density"
            android:launchMode="singleTask"
            android:windowSoftInputMode="adjustResize">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>

        <service
            android:name=".TrackService"
            android:exported="false"
            android:foregroundServiceType="location" />

        <service
            android:name=".AnchorService"
            android:exported="false"
            android:foregroundServiceType="location" />

        <provider
            android:name="androidx.core.content.FileProvider"
            android:authorities="${applicationId}.fileprovider"
            android:exported="false"
            android:grantUriPermissions="true">
            <meta-data android:name="android.support.FILE_PROVIDER_PATHS" android:resource="@xml/file_paths" />
        </provider>
    </application>
</manifest>
```

## `app/build.gradle.kts`

```kotlin
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.stms.trawler"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.stms.trawler"   // Firebase-এ যে প্যাকেজ নাম দেবেন সেটাই এখানে
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    buildFeatures { buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.4")
    implementation("androidx.webkit:webkit:1.11.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    // নেটিভ Google সাইন-ইন
    implementation("androidx.credentials:credentials:1.3.0")
    implementation("androidx.credentials:credentials-play-services-auth:1.3.0")
    implementation("com.google.android.libraries.identity.googleid:googleid:1.1.1")
}
```

## `build.gradle.kts`

```kotlin
plugins {
    id("com.android.application") version "8.5.2" apply false
    id("org.jetbrains.kotlin.android") version "1.9.24" apply false
}
```

## `settings.gradle.kts`

```kotlin
pluginManagement {
    repositories { google(); mavenCentral(); gradlePluginPortal() }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories { google(); mavenCentral() }
}
rootProject.name = "STMS"
include(":app")
```

## `app/src/main/res/values/strings.xml`

```xml
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="app_name">STMS</string>
    <!-- Firebase Console → Authentication → Sign-in method → Google → Web SDK configuration → Web client ID -->
    <string name="default_web_client_id" translatable="false">YOUR_WEB_CLIENT_ID.apps.googleusercontent.com</string>
</resources>
```

## `app/src/main/res/values/themes.xml`

```xml
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <style name="Theme.STMS" parent="Theme.AppCompat.DayNight.NoActionBar">
        <item name="android:statusBarColor">#075985</item>
        <item name="android:navigationBarColor">#0f172a</item>
        <item name="android:windowBackground">#075985</item>
        <item name="android:windowLightStatusBar">false</item>
    </style>
</resources>
```

## `app/src/main/res/xml/file_paths.xml`

```xml
<?xml version="1.0" encoding="utf-8"?>
<paths>
    <cache-path name="images" path="images/" />
</paths>
```

