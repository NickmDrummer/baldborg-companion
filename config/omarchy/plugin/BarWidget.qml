import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui

// Baldborg — bar pill that mirrors the overlay state.
//   left click  : toggle the chat
//   right click : mute / unmute the voice
// State comes from the overlay's control socket (`bin/baldborg status`).
BarWidget {
  id: root
  moduleName: "nickmdrummer.baldborg"

  // idle | busy | muted | offline
  property string phase: "offline"

  // The installer substitutes __REPO__ with the checkout location.
  readonly property string bin: "__REPO__/bin/baldborg"

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  Process {
    id: statusProc
    command: [root.bin, "status"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        const raw = String(text || "").trim()
        if (!raw) {
          root.phase = "offline"
          return
        }
        try {
          const state = JSON.parse(raw)
          root.phase = state.busy ? "busy" : (state.muted ? "muted" : "idle")
        } catch (error) {
          root.phase = "offline"
        }
      }
    }
  }

  Process {
    id: actionProc
    function fire(args) {
      command = [root.bin].concat(args)
      running = true
    }
  }

  Timer {
    interval: 5000
    running: true
    repeat: true
    triggeredOnStart: true
    onTriggered: statusProc.running = true
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.vertical ? "" : "BALDBORG"
    labelVisible: !root.vertical
    active: root.phase === "busy"
    dimmed: root.phase === "muted" || root.phase === "offline"
    tooltipText: root.phase === "offline"
      ? "Baldborg no está en marcha"
      : (root.phase === "muted" ? "Baldborg · voz silenciada" : "Baldborg · clic para abrir")

    onPressed: function(buttonPressed) {
      if (buttonPressed === Qt.RightButton) actionProc.fire(["mute"])
      else actionProc.fire(["toggle"])
    }
  }
}
