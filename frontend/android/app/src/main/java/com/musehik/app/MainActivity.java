package com.musehik.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NativePlayerPlugin.class); // the app's own plugin: Android's music player (MusicService)
        registerPlugin(MusicFolderPlugin.class); // and the phone's Music folder (MediaStore)
        super.onCreate(savedInstanceState);
    }
}
