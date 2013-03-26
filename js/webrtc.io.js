//CLIENT

 // Fallbacks for vendor-specific variables until the spec is finalized.

var PeerConnection = window.PeerConnection || window.webkitPeerConnection00 || window.webkitRTCPeerConnection;
var URL = window.URL || window.webkitURL || window.msURL || window.oURL;
var getUserMedia = navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia || navigator.msGetUserMedia;

(function() {

  var rtc;
  if ('undefined' === typeof module) {
    rtc = this.rtc = {};
  } else {
    rtc = module.exports = {};
  }


  // Holds a connection to the server.
  rtc._socket = null;

  // Holds identity for the client
  rtc._me = null;

  // Holds callbacks for certain events.
  rtc._events = {};

  rtc.on = function(eventName, callback) {
    rtc._events[eventName] = rtc._events[eventName] || [];
    rtc._events[eventName].push(callback);
  };

  rtc.fire = function(eventName, _) {
    var events = rtc._events[eventName];
    var args = Array.prototype.slice.call(arguments, 1);

    if (!events) {
      return;
    }

    for (var i = 0, len = events.length; i < len; i++) {
      events[i].apply(null, args);
    }
  };

  // Holds the STUN/ICE server to use for PeerConnections.
  rtc.SERVER = {iceServers:[{url:"stun:stun.l.google.com:19302"}]};

  // Reference to the lone PeerConnection instance.
  rtc.peerConnections = {};

  // Array of known peer client ids
  rtc.connections = [];
  // Stream-related variables.
  rtc.streams = [];
  rtc.numStreams = 0;
  rtc.initializedStreams = 0;


  // Reference to the data channels
  rtc.dataChannels = {};

  // PeerConnection datachannel configuration
  rtc.dataChannelConfig = {optional: [ {RtpDataChannels: true} ] };


  // check whether data channel is supported.
  rtc.checkDataChannelSupport = function() {
    try {
      // raises exception if createDataChannel is not supported
      var pc = new PeerConnection(rtc.SERVER, rtc.dataChannelConfig);
      var channel = pc.createDataChannel('supportCheck', {reliable: false});
      channel.close();
      return true;
    } catch(e) {
      return false;
    }
  };

  rtc.dataChannelSupport = rtc.checkDataChannelSupport();


  /**
   * Connects to the server.
   */
  rtc.connect = function() {
    console.log('open channel');
    var channel = new goog.appengine.Channel('{{ token }}');
    var handler = {
      'onopen': onChannelOpened,
      'onmessage': onChannelMessage,
      'onerror': onChannelError,
      'onclose': onChannelClosed
    };

    rtc._socket = channel.open(handler);
  }

  function onChannelOpened() {
    sendMessage({
        "eventName": "join_room",
        "data":{
          "room": room
        }
    });

    rtc.on('get_peers', function(data) {
      // rtc.connections = data.connections;
      // rtc._me = data.you;
      // // fire connections event and pass peers
      // rtc.fire('connections', rtc.connections);
    });

    rtc.on('receive_ice_candidate', function(data) {
      var candidate = new RTCIceCandidate(data);
      rtc.peerConnections[data.socketId].addIceCandidate(candidate);
      rtc.fire('receive ice candidate', candidate);
    });

    rtc.on('new_peer_connected', function(data) {
      rtc.connections.push(data.clientId);

      var pc = rtc.createPeerConnection(data.socketId);
      for (var i = 0; i < rtc.streams.length; i++) {
        var stream = rtc.streams[i];
        pc.addStream(stream);
      }
    });

    rtc.on('remove_peer_connected', function(data) {
      rtc.fire('disconnect stream', data.socketId);
      delete rtc.peerConnections[data.socketId];
    });

    rtc.on('receive_offer', function(data) {
      rtc.receiveOffer(data.socketId, data.sdp);
      rtc.fire('receive offer', data);
    });

    rtc.on('receive_answer', function(data) {
      rtc.receiveAnswer(data.socketId, data.sdp);
      rtc.fire('receive answer', data);
    });

    rtc.fire('connect');
  }

  function onChannelMessage(msg) {
    var json = JSON.parse(msg.data);
    rtc.fire(json.eventName, json.data);
  }

  function onChannelError() {
    console.error('onerror');
    console.error(err);
  }

  function onChannelClosed() {
    rtc.fire('disconnect stream', rtc._socket.id);
    delete rtc.peerConnections[rtc._socket.id];
  }

  function sendMessage(msg) {
    var msgString = JSON.stringify(msg);
    console.log('C->S: ' + msgString);
    path = '/message?r={{ room_key }}' + '&u={{ me }}';
    var xhr = new XMLHttpRequest();
    xhr.open('POST', path, true);
    xhr.send(msgString);
  }

  rtc.sendOffers = function() {
    for (var i = 0, len = rtc.connections.length; i < len; i++) {
      var clientId = rtc.connections[i];
      rtc.sendOffer(clientId);
    }
  };

  rtc.onClose = function(data) {
    rtc.on('close_stream', function() {
      rtc.fire('close_stream', data);
    });
  };

  rtc.createPeerConnections = function() {
    for (var i = 0; i < rtc.connections.length; i++) {
      rtc.createPeerConnection(rtc.connections[i]);
    }
  };

  rtc.createPeerConnection = function(id) {
    var config;
    if (rtc.dataChannelSupport)
      config = rtc.dataChannelConfig;

    var pc = rtc.peerConnections[id] = new PeerConnection(rtc.SERVER, config);
    pc.onicecandidate = function(event) {
      if (event.candidate) {
         sendMessage({
           "eventName": "send_ice_candidate",
           "data": {
              "label": event.candidate.label,
              "candidate": event.candidate.candidate,
              "clientId": id
           }
         });
       }
       rtc.fire('ice candidate', event.candidate);
     };

    pc.onopen = function() {
      // TODO: Finalize this API
      rtc.fire('peer connection opened');
    };

    pc.onaddstream = function(event) {
      // TODO: Finalize this API
      rtc.fire('add remote stream', event.stream, id);
    };

    if (rtc.dataChannelSupport) {
      pc.ondatachannel = function (evt) {
        console.log('data channel connecting ' + id);
        rtc.addDataChannel(id, evt.channel);
      };
    }

    return pc;
  };

  rtc.sendOffer = function(clientId) {
    var pc = rtc.peerConnections[clientId];
    pc.createOffer( function(session_description) {
    pc.setLocalDescription(session_description);
    sendMessage({
        "eventName": "send_offer",
        "data":{
            "clientId": clientId,
            "sdp": session_description
            }
        });
    });
  };


  rtc.receiveOffer = function(clientId, sdp) {
    var pc = rtc.peerConnections[clientId];
    pc.setRemoteDescription(new RTCSessionDescription(sdp));
    rtc.sendAnswer(clientId);
  };


  rtc.sendAnswer = function(clientId) {
    var pc = rtc.peerConnections[clientId];
    pc.createAnswer( function(session_description) {
    pc.setLocalDescription(session_description);
    sendMessage({
        "eventName": "send_answer",
        "data":{
            "clientId": clientId,
            "sdp": session_description
            }
        }
    );
    //TODO Unused variable!?
    var offer = pc.remoteDescription;
    });
  };


  rtc.receiveAnswer = function(clientId, sdp) {
    var pc = rtc.peerConnections[clientId];
    pc.setRemoteDescription(new RTCSessionDescription(sdp));
  };


  rtc.createStream = function(opt, onSuccess, onFail) {
    var options;
    onSuccess = onSuccess ||
    function() {};
    onFail = onFail ||
    function() {};

    options = {
      video: !!opt.video,
      audio: !!opt.audio
    };

    if (getUserMedia) {
      rtc.numStreams++;
      getUserMedia.call(navigator, options, function(stream) {

        rtc.streams.push(stream);
        rtc.initializedStreams++;
        onSuccess(stream);
        if (rtc.initializedStreams === rtc.numStreams) {
          rtc.fire('ready');
        }
      }, function() {
        alert("Could not connect stream.");
        onFail();
      });
    } else {
      alert('webRTC is not yet supported in this browser.');
    }
  };

  rtc.addStreams = function() {
    for (var i = 0; i < rtc.streams.length; i++) {
      var stream = rtc.streams[i];
      for (var connection in rtc.peerConnections) {
        rtc.peerConnections[connection].addStream(stream);
      }
    }
  };

  rtc.attachStream = function(stream, domId) {
    document.getElementById(domId).src = URL.createObjectURL(stream);
  };


  rtc.createDataChannel = function(pcOrId, label) {
    if (!rtc.dataChannelSupport) {
      //TODO this should be an exception
      alert('webRTC data channel is not yet supported in this browser,' +
            ' or you must turn on experimental flags');
      return;
    }

    var id, pc;
    if (typeof(pcOrId) === 'string') {
      id = pcOrId;
      pc = rtc.peerConnections[pcOrId];
    } else {
      pc = pcOrId;
      id = undefined;
      for (var key in rtc.peerConnections) {
        if (rtc.peerConnections[key] === pc)
          id = key;
      }
    }

    if (!id)
      throw new Error ('attempt to createDataChannel with unknown id');

    if (!pc || !(pc instanceof PeerConnection))
      throw new Error ('attempt to createDataChannel without peerConnection');

    // need a label
    label = label || 'fileTransfer' || String(id);

    // chrome only supports reliable false atm.
    var options = {reliable: false};

    var channel;
    try {
      console.log('createDataChannel ' + id);
      channel = pc.createDataChannel(label, options);
    } catch (error) {
      console.log('seems that DataChannel is NOT actually supported!');
      throw error;
    }

    return rtc.addDataChannel(id, channel);
  };

  rtc.addDataChannel = function(id, channel) {

    channel.onopen = function() {
      console.log('data stream open ' + id);
      rtc.fire('data stream open', channel);
    };

    channel.onclose = function(event) {
      delete rtc.dataChannels[id];
      console.log('data stream close ' + id);
      rtc.fire('data stream close', channel);
    };

    channel.onmessage = function(message) {
      console.log('data stream message ' + id);
      console.log(message);
      rtc.fire('data stream data', channel, message.data);
    };

    channel.onerror = function(err) {
      console.log('data stream error ' + id + ': ' + err);
      rtc.fire('data stream error', channel, err);
    };

    // track dataChannel
    rtc.dataChannels[id] = channel;
    return channel;
  };

  rtc.addDataChannels = function() {
    if (!rtc.dataChannelSupport)
      return;

    for (var connection in rtc.peerConnections)
      rtc.createDataChannel(connection);
  };


  rtc.on('ready', function() {
    rtc.createPeerConnections();
    rtc.addStreams();
    rtc.addDataChannels();
    rtc.sendOffers();
  });

}).call(this);
