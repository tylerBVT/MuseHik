package com.musehik.app;

import android.app.PendingIntent;
import android.content.Intent;

import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.Player;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.extractor.DefaultExtractorsFactory;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaSessionService;

/**
 * The phone's music player (Android's Media3), running as a service: it lives on without the app's screen, so the music
 * goes on with the screen off and after the app is swiped away from the recent apps, like Deezer. The web player
 * (core/native-audio.ts, through NativePlayerPlugin) hands it the whole play order and drives it; it moves to the next
 * song by itself.
 * Media3 also does: the media notification and lock screen player (previous / play-pause / next, progress), headset and
 * Bluetooth buttons, audio focus (a call pauses the music, it plays on afterwards; another music app stops it) and
 * pausing when headphones are unplugged.
 */
public class MusicService extends MediaSessionService {
    /** The web player's own state (queue, order, modes), handed back when the app opens again while this still plays. */
    static volatile String context = "";

    private MediaSession session;

    @Override
    public void onCreate() {
        super.onCreate();
        // LWS's edge cache hides the file size and answers "from byte N" requests with the whole file: let the player
        // seek in MP3s of unknown size (constant bitrate assumed; it skips ahead in the stream when needed).
        DefaultExtractorsFactory extractors = new DefaultExtractorsFactory()
            .setConstantBitrateSeekingEnabled(true)
            .setConstantBitrateSeekingAlwaysEnabled(true);
        ExoPlayer player = new ExoPlayer.Builder(this)
            .setMediaSourceFactory(new DefaultMediaSourceFactory(this, extractors))
            .setAudioAttributes(new AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(), true)
            .setHandleAudioBecomingNoisy(true)
            .setWakeMode(C.WAKE_MODE_NETWORK) // keeps the CPU and Wi-Fi awake while streaming with the screen off
            .build();
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent tap = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        session = new MediaSession.Builder(this, player).setSessionActivity(tap).build();
    }

    @Override
    public MediaSession onGetSession(MediaSession.ControllerInfo controllerInfo) {
        return session;
    }

    /** Swiped away from the recent apps: keep playing if music plays, otherwise there is nothing to keep. */
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        Player player = session.getPlayer();
        boolean playing = player.getPlayWhenReady() && player.getMediaItemCount() > 0 && player.getPlaybackState() != Player.STATE_ENDED;
        if (!playing) stopSelf();
    }

    @Override
    public void onDestroy() {
        if (session != null) {
            session.getPlayer().release();
            session.release();
            session = null;
        }
        context = "";
        super.onDestroy();
    }
}
