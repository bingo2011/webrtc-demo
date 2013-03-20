var videos = [];
var PeerConnection = window.PeerConnection || window.webkitPeerConnection00 || window.webkitRTCPeerConnection;

function init() {
  if(PeerConnection) {
    rtc.createStream({
      "video": true,
      "audio": true
    }, function(stream) {
      document.getElementById('you').src = URL.createObjectURL(stream);
      videos.push(document.getElementById('you'));
      rtc.attachStream(stream, 'you');
      // subdivideVideos();
    });
  } else {
    alert('Your browser is not supported or you have to turn on flags. In chrome you go to chrome://flags and turn on Enable PeerConnection remember to restart chrome');
  }
}