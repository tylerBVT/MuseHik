package com.musehik.app;

import android.Manifest;
import android.content.ComponentName;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.session.MediaController;
import androidx.media3.session.SessionToken;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.common.util.concurrent.ListenableFuture;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;

/**
 * The web player's remote control for MusicService (core/native-audio.ts). Commands run on the main thread in the
 * order they were sent; until the connection to the service is up they wait. Everything the player does comes back
 * as a "state" event: play, pause, time, duration, ended (end of the plan), error, item (on another song, and why).
 */
@CapacitorPlugin(name = "NativePlayer")
public class NativePlayerPlugin extends Plugin {
    private static final String TAG = "NativePlayer";
    private final Handler main = new Handler(Looper.getMainLooper());
    private final List<Consumer<MediaController>> waiting = new ArrayList<>();
    private ListenableFuture<MediaController> connecting;
    private MediaController controller;
    private boolean askedForNotifications = false;
    private double lastDuration = -1;

    private final Runnable ticker = new Runnable() {
        @Override
        public void run() {
            if (controller != null && controller.isPlaying()) {
                emit("time", null, null);
                double duration = seconds(controller.getDuration());
                if (duration != lastDuration) emit("duration", null, null);
            }
            main.postDelayed(this, 500);
        }
    };

    private final Player.Listener listener = new Player.Listener() {
        @Override
        public void onPlayWhenReadyChanged(boolean playWhenReady, int reason) {
            emit(playWhenReady ? "play" : "pause", null, null);
        }

        @Override
        public void onPlaybackStateChanged(int state) {
            if (state == Player.STATE_READY) emit("duration", null, null);
            if (state == Player.STATE_ENDED) emit("ended", null, null);
        }

        @Override
        public void onMediaItemTransition(MediaItem item, int reason) {
            String why = reason == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO ? "auto"
                : reason == Player.MEDIA_ITEM_TRANSITION_REASON_REPEAT ? "repeat"
                : reason == Player.MEDIA_ITEM_TRANSITION_REASON_SEEK ? "seek" : "plan";
            emit("item", why, null);
        }

        @Override
        public void onPlayerError(PlaybackException error) {
            emit("error", null, error.getErrorCodeName());
        }
    };

    @Override
    public void load() {
        main.post(() -> {
            SessionToken token = new SessionToken(getContext(), new ComponentName(getContext(), MusicService.class));
            connecting = new MediaController.Builder(getContext(), token).buildAsync();
            connecting.addListener(() -> {
                try {
                    controller = connecting.get();
                } catch (Exception e) {
                    Log.e(TAG, "Could not connect to the music service", e);
                    return;
                }
                controller.addListener(listener);
                for (Consumer<MediaController> action : waiting) action.accept(controller);
                waiting.clear();
                main.post(ticker);
            }, ContextCompat.getMainExecutor(getContext()));
        });
    }

    @Override
    protected void handleOnDestroy() {
        // The app's screen is gone; the music service plays on by itself.
        main.removeCallbacks(ticker);
        if (controller != null) {
            controller.removeListener(listener);
            controller.release();
            controller = null;
        } else if (connecting != null) {
            MediaController.releaseFuture(connecting);
        }
    }

    /** Runs on the main thread once connected; the action resolves the call. */
    private void run(PluginCall call, Consumer<MediaController> action) {
        main.post(() -> {
            Consumer<MediaController> safe = c -> {
                try {
                    action.accept(c);
                } catch (Exception e) {
                    call.reject(e.getMessage());
                }
            };
            if (controller != null) safe.accept(controller);
            else waiting.add(safe);
        });
    }

    @PluginMethod
    public void setPlan(PluginCall call) {
        List<MediaItem> items = new ArrayList<>();
        JSArray list = call.getArray("items", new JSArray());
        try {
            for (int i = 0; i < list.length(); i++) {
                JSONObject o = list.getJSONObject(i);
                items.add(new MediaItem.Builder()
                    .setUri(o.optString("url"))
                    .setMediaId(i + ":" + o.optString("url"))
                    .setMediaMetadata(new MediaMetadata.Builder()
                        .setTitle(o.optString("title"))
                        .setArtist(o.optString("artist"))
                        .setAlbumTitle(o.optString("album"))
                        .build())
                    .build());
            }
        } catch (Exception e) {
            call.reject("Bad play order: " + e.getMessage());
            return;
        }
        int index = Math.max(0, Math.min(call.getInt("index", 0), Math.max(0, items.size() - 1)));
        String repeat = call.getString("repeat", "off");
        String context = call.getString("context", "");
        run(call, c -> {
            MusicService.context = context;
            c.setRepeatMode("one".equals(repeat) ? Player.REPEAT_MODE_ONE : "all".equals(repeat) ? Player.REPEAT_MODE_ALL : Player.REPEAT_MODE_OFF);
            MediaItem current = c.getCurrentMediaItem();
            boolean keep = current != null && !items.isEmpty() && sameUri(current, items.get(index));
            if (keep) {
                // The song playing stays where it is (no break in the sound); only the songs around it change.
                int here = c.getCurrentMediaItemIndex();
                c.replaceMediaItems(here + 1, c.getMediaItemCount(), items.subList(index + 1, items.size()));
                c.replaceMediaItems(0, here, items.subList(0, index));
            } else {
                c.setMediaItems(items, index, 0);
                c.prepare();
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void select(PluginCall call) {
        int index = call.getInt("index", 0);
        run(call, c -> {
            if (index < c.getMediaItemCount()) c.seekTo(index, 0);
            if (c.getPlaybackState() == Player.STATE_IDLE) c.prepare();
            call.resolve();
        });
    }

    @PluginMethod
    public void play(PluginCall call) {
        askForNotifications();
        run(call, c -> {
            if (c.getPlaybackState() == Player.STATE_IDLE) c.prepare();
            c.play();
            call.resolve();
        });
    }

    @PluginMethod
    public void pause(PluginCall call) {
        run(call, c -> {
            c.pause();
            emit("time", null, null);
            call.resolve();
        });
    }

    @PluginMethod
    public void seek(PluginCall call) {
        double seconds = call.getDouble("seconds", 0.0);
        run(call, c -> {
            c.seekTo((long) (seconds * 1000));
            call.resolve();
        });
    }

    @PluginMethod
    public void setVolume(PluginCall call) {
        float volume = call.getFloat("volume", 1f);
        run(call, c -> {
            c.setVolume(volume);
            call.resolve();
        });
    }

    /** What still plays (the app was closed and opened again); empty when nothing. */
    @PluginMethod
    public void getState(PluginCall call) {
        run(call, c -> {
            JSObject state = new JSObject();
            if (c.getMediaItemCount() > 0 && !MusicService.context.isEmpty() && c.getPlaybackState() != Player.STATE_ENDED) {
                state.put("context", MusicService.context);
                state.put("index", c.getCurrentMediaItemIndex());
                state.put("playing", c.getPlayWhenReady());
                state.put("position", seconds(c.getCurrentPosition()));
                state.put("duration", seconds(c.getDuration()));
            }
            call.resolve(state);
        });
    }

    private void emit(String type, String reason, String message) {
        MediaController c = controller;
        if (c == null) return;
        JSObject data = new JSObject();
        data.put("type", type);
        data.put("index", c.getCurrentMediaItemIndex());
        data.put("position", seconds(c.getCurrentPosition()));
        double duration = seconds(c.getDuration());
        data.put("duration", duration);
        if ("duration".equals(type)) lastDuration = duration;
        if (reason != null) data.put("reason", reason);
        if (message != null) data.put("message", message);
        notifyListeners("state", data);
    }

    private static double seconds(long ms) {
        return ms == C.TIME_UNSET || ms < 0 ? 0 : ms / 1000.0;
    }

    private static boolean sameUri(MediaItem a, MediaItem b) {
        Uri x = a.localConfiguration != null ? a.localConfiguration.uri : null;
        Uri y = b.localConfiguration != null ? b.localConfiguration.uri : null;
        return x != null && x.equals(y);
    }

    /** Android 13+: without it the media notification (and its buttons) stays hidden; the music still plays. Asked once. */
    private void askForNotifications() {
        if (askedForNotifications || Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || getActivity() == null) return;
        askedForNotifications = true;
        if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(getActivity(), new String[] { Manifest.permission.POST_NOTIFICATIONS }, 7301);
        }
    }
}
