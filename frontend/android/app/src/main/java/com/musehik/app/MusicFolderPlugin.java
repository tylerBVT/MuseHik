package com.musehik.app;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.database.Cursor;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The phone's Music folder, through Android's media index (MediaStore): the songs in it (copied by cable too, so they
 * show in All tracks), saving a downloaded cloud song into Music/MuseHik (visible from a computer), and deleting songs
 * this app saved. Reading the songs other apps or a computer put there needs the "music and audio" permission, asked
 * once; without it Android lists only the songs this app saved.
 */
@CapacitorPlugin(
    name = "MusicFolder",
    permissions = {
        @Permission(alias = "audio", strings = { Manifest.permission.READ_MEDIA_AUDIO }),
        @Permission(alias = "storage", strings = { Manifest.permission.READ_EXTERNAL_STORAGE, Manifest.permission.WRITE_EXTERNAL_STORAGE }),
    }
)
public class MusicFolderPlugin extends Plugin {
    private static final String FOLDER = "MuseHik";
    private final ExecutorService work = Executors.newSingleThreadExecutor();

    private static String alias() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU ? "audio" : "storage";
    }

    @PluginMethod
    public void list(PluginCall call) {
        if (getPermissionState(alias()) == PermissionState.PROMPT || getPermissionState(alias()) == PermissionState.PROMPT_WITH_RATIONALE) {
            requestPermissionForAlias(alias(), call, "listAfterAsking");
        } else {
            work.execute(() -> listNow(call));
        }
    }

    @PermissionCallback
    private void listAfterAsking(PluginCall call) {
        work.execute(() -> listNow(call)); // allowed or not: without it, the songs this app saved
    }

    private void listNow(PluginCall call) {
        ContentResolver resolver = getContext().getContentResolver();
        Uri table = MediaStore.Audio.Media.EXTERNAL_CONTENT_URI;
        boolean scoped = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q;
        String[] columns = scoped
            ? new String[] { "_id", "title", "artist", "album", "duration", "date_added", "_size", "owner_package_name" }
            : new String[] { "_id", "title", "artist", "album", "duration", "date_added", "_size" };
        // Everything under Music/ (any sub-folder), except what Android marks as not music (ringtones, recordings...).
        String where = scoped ? "is_music != 0 AND relative_path LIKE 'Music/%'" : "is_music != 0 AND _data LIKE ?";
        String[] args = scoped ? null : new String[] { Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MUSIC).getAbsolutePath() + "/%" };
        JSArray songs = new JSArray();
        try (Cursor c = resolver.query(table, columns, where, args, "date_added DESC")) {
            if (c != null) {
                String me = getContext().getPackageName();
                while (c.moveToNext()) {
                    long id = c.getLong(0);
                    JSObject s = new JSObject();
                    s.put("id", id);
                    s.put("uri", ContentUris.withAppendedId(table, id).toString());
                    s.put("title", text(c.getString(1)));
                    s.put("artist", text(c.getString(2)));
                    s.put("album", text(c.getString(3)));
                    s.put("duration", c.getLong(4) / 1000.0);
                    s.put("addedAt", iso(c.getLong(5)));
                    s.put("size", c.getLong(6));
                    s.put("mine", scoped && me.equals(c.getString(7)));
                    songs.put(s);
                }
            }
        } catch (Exception e) {
            call.reject("Cannot read the Music folder: " + e.getMessage());
            return;
        }
        JSObject result = new JSObject();
        result.put("songs", songs);
        call.resolve(result);
    }

    /** Copies `from` (a file of the app's storage) into Music/MuseHik as `name`; returns its media id and URI. */
    @PluginMethod
    public void save(PluginCall call) {
        String from = call.getString("from", "");
        String name = call.getString("name", "song.mp3");
        work.execute(() -> {
            try {
                File source = new File(Uri.parse(from).getPath());
                Uri uri = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ? saveScoped(source, name) : saveLegacy(source, name);
                JSObject result = new JSObject();
                result.put("id", ContentUris.parseId(uri));
                result.put("uri", uri.toString());
                call.resolve(result);
            } catch (Exception e) {
                call.reject("Cannot save it into the Music folder: " + e.getMessage());
            }
        });
    }

    private Uri saveScoped(File source, String name) throws Exception {
        ContentResolver resolver = getContext().getContentResolver();
        ContentValues v = new ContentValues();
        v.put(MediaStore.Audio.Media.DISPLAY_NAME, name);
        v.put(MediaStore.Audio.Media.RELATIVE_PATH, Environment.DIRECTORY_MUSIC + "/" + FOLDER);
        v.put(MediaStore.Audio.Media.IS_PENDING, 1); // hidden from other apps until complete
        Uri uri = resolver.insert(MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), v);
        if (uri == null) throw new Exception("Android refused the new file.");
        try (InputStream in = new java.io.FileInputStream(source); OutputStream out = resolver.openOutputStream(uri)) {
            if (out == null) throw new Exception("Cannot write the new file.");
            copy(in, out);
        } catch (Exception e) {
            resolver.delete(uri, null, null);
            throw e;
        }
        ContentValues done = new ContentValues();
        done.put(MediaStore.Audio.Media.IS_PENDING, 0); // Android now reads its tags (title, artist, length)
        resolver.update(uri, done, null, null);
        return uri;
    }

    private Uri saveLegacy(File source, String name) throws Exception {
        File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MUSIC), FOLDER);
        if (!dir.isDirectory() && !dir.mkdirs()) throw new Exception("Cannot create Music/" + FOLDER + ".");
        File target = new File(dir, name);
        try (InputStream in = new java.io.FileInputStream(source); OutputStream out = new FileOutputStream(target)) {
            copy(in, out);
        }
        final Uri[] found = { null };
        final Object lock = new Object();
        MediaScannerConnection.scanFile(getContext(), new String[] { target.getAbsolutePath() }, null, (path, uri) -> {
            synchronized (lock) {
                found[0] = uri;
                lock.notifyAll();
            }
        });
        synchronized (lock) {
            if (found[0] == null) lock.wait(15000);
        }
        if (found[0] == null) throw new Exception("Android did not index the new file.");
        return found[0];
    }

    /** Deletes a song this app saved. Android refuses for the others (copied by cable): the call fails. */
    @PluginMethod
    public void delete(PluginCall call) {
        long id = call.getData().optLong("id", -1L); // call.getLong() ignores numbers that fit in an int
        work.execute(() -> {
            try {
                Uri uri = ContentUris.withAppendedId(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, id);
                if (getContext().getContentResolver().delete(uri, null, null) < 1) throw new Exception("Not found.");
                call.resolve();
            } catch (Exception e) {
                call.reject("Cannot delete it: " + e.getMessage());
            }
        });
    }

    private static void copy(InputStream in, OutputStream out) throws Exception {
        byte[] buffer = new byte[64 * 1024];
        int n;
        while ((n = in.read(buffer)) > 0) out.write(buffer, 0, n);
    }

    private static String text(String s) {
        return s == null || "<unknown>".equals(s) ? "" : s;
    }

    private static String iso(long seconds) {
        SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT);
        f.setTimeZone(TimeZone.getTimeZone("UTC"));
        return f.format(new Date(seconds * 1000));
    }
}
