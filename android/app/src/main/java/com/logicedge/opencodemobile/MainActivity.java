package com.logicedge.opencodemobile;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ServerEventsPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
