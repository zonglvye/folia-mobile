# Folia Mobile shell — ProGuard rules.
# Minification is off by default; these rules exist so enabling it later cannot strip the
# JavaScript bridge, whose methods are only ever called by name from the web page.
-keepclassmembers class app.folia.mobile.FoliaBridge {
    public *;
}
-keep class app.folia.mobile.FoliaBridge { *; }
