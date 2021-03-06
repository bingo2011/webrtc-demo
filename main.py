#!/usr/bin/env python
#
# Copyright 2007 Google Inc.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
#
import cgi
import logging
import os
import random
import json
import jinja2
import webapp2
import threading
from google.appengine.api import channel
from google.appengine.ext import db

jinja_environment = jinja2.Environment(
    loader=jinja2.FileSystemLoader(os.path.dirname(__file__)))

LOCK = threading.RLock()

def generate_random(len):
    word = ''
    for i in range(len):
       word += random.choice('123456789')
    return word

def append_url_argument(request, link):
    for argument in request.arguments():
        if argument != 'r':
            link += ('&' + cgi.escape(argument, True) + '=' +
	             cgi.escape(request.get(argument), True))
    return link    

def make_client_id(room, user):
    return room.key().id_or_name() + '/' + user

def make_message(eventName, data):
    msg = {}
    msg["eventName"] = eventName
    msg["data"] = data
    # print 'Sending message ' + json.dumps(msg)
    return json.dumps(msg)

def handle_message(room, user, message):
    message_obj = json.loads(message)
    eventName = message_obj['eventName']
    data = message_obj['data']

    # print message_obj

    if eventName == 'join_room':
        room_key = data['room']
        room = Room.get_by_key_name(room_key)
        if room:
            other_users = room.get_other_users(user)

            # 'get_peers'
            if other_users:
                connections = [make_client_id(room, other) for other in other_users]
                data = {"connections":connections}
            else:
                data = {"connections":[]}
            message = make_message('get_peers', data)
            channel.send_message(make_client_id(room, user), message)

            # 'new_peer_connected'
            if other_users: 
                data = {'socketId': make_client_id(room, user)}
                message = make_message('new_peer_connected', data)
                for other in other_users:
                    channel.send_message(make_client_id(room, other), message)
    
    elif eventName == 'send_offer':
        client_id = data['socketId']

        data = {"sdp":data['sdp'], "socketId":make_client_id(room, user)}
        message = make_message('receive_offer', data)
        
        channel.send_message(client_id, message)

    elif eventName == 'send_answer':
        client_id = data['socketId']

        data = {"sdp":data['sdp'], "socketId":make_client_id(room, user)}
        message = make_message('receive_answer', data)
        
        channel.send_message(client_id, message)

    elif eventName == 'send_ice_candidate':
        client_id = data['socketId']

        data = {"label": data['label'], "candidate": data['candidate'], "socketId":make_client_id(room, user)}
        message = make_message('receive_ice_candidate', data)

        channel.send_message(client_id, message)


class Room(db.Model):
    #user_ids = db.ListProperty(str)
    user_ids = db.StringListProperty()

    def add_user(self, user):
        self.user_ids.append(user)
        self.put()

    def get_other_users(self, user):
        if user in self.user_ids:
            others = list(self.user_ids)
            others.remove(user)
            return others
        else:
            return []

    def has_user(self, user):
        return user in self.user_ids

    def remove_user(self, user):
        if user in self.user_ids:
            self.user_ids.remove(user)
            if len(self.user_ids) > 0:
                self.put()
            else:
                self.delete()

    def get_count(self):
        return len(self.user_ids)

class ConnectPage(webapp2.RequestHandler):
    def post(self):
        key = self.request.get('from')
        room_key, user = key.split('/')
        with LOCK:
            room = Room.get_by_key_name(room_key)
            if room and room.has_user(user):
                logging.info('User ' + user + ' connected to room ' + room_key)
                logging.info('Room ' + room_key + ' has ' + str(room.get_count()) + ' participant(s)')
            else:
                logging.warning('Unexpected Connect Message to room ' + room_key)


class DisconnectPage(webapp2.RequestHandler):
    def post(self):
        key = self.request.get('from')
        room_key, user = key.split('/')
        with LOCK:
            room = Room.get_by_key_name(room_key)
            if room and room.has_user(user):
                other_users = room.get_other_users(user)
                if other_users:
                    for other in other_users:
                        channel.send_message(make_client_id(room, other), '{"type": "bye"}')
                        logging.info('Sent BYE to ' + other)

                room.remove_user(user)
                logging.info('User ' + user + ' removed from room ' + room_key)
                logging.info('Room ' + room_key + ' has ' + str(room.get_count()) + ' participant(s)')

        logging.warning('User ' + user + ' disconnected from room ' + room_key)


class MessagePage(webapp2.RequestHandler):
    def post(self):
        message = self.request.body
        room_key = self.request.get('r')
        user = self.request.get('u')

        with LOCK:			
            room = Room.get_by_key_name(room_key)
            if room:
                handle_message(room, user, message)
            else:
                logging.warning('Unknown room ' + room_key)


class MainHandler(webapp2.RequestHandler):
    def get(self):
    	"""Renders the main page. When this page is shown, we create a new 
	       channel to push asynchronous updates to the client. """
    	base_url = self.request.path_url
    	room_key = self.request.get('r')
    	token_timeout = self.request.get_range('tt',
    		                                    min_value = 3,
    		                                    max_value = 3000,
    		                                    default = 30)
    	if not room_key:
            room_key = generate_random(8)
            redirect = '?r=' + room_key
            redirect = append_url_argument(self.request, redirect)
            self.redirect(redirect)
            logging.info('Redirecting vistor to base URL to ' + redirect)
            return

        with LOCK:
            room = Room.get_by_key_name(room_key)
            if not room:
                room = Room(key_name = room_key)

        user = generate_random(8)      
        room.add_user(user)

        client_id = make_client_id(room, user)
    	token = channel.create_channel(client_id, token_timeout)
        template_values = {'token': token,
        				   'me': user,
        				   'room_key': room_key
        				   }
        target_page = 'index.html'

        template = jinja_environment.get_template(target_page)
        self.response.out.write(template.render(template_values))

app = webapp2.WSGIApplication([
    ('/', MainHandler),
    ('/message', MessagePage),
    ('/_ah/channel/connected/', ConnectPage),
    ('/_ah/channel/disconnected/', DisconnectPage),
], debug=True)
