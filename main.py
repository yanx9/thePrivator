from selenium import webdriver
import platform
import os
import subprocess
from Model.Profile import Profile
import time
import shlex, shutil
import json

user_data_root = "Profiles"
loaded_profiles = []
chromium_path = "/opt/homebrew/bin/chromium"
active_processes = {}
print(platform.platform())
def config_prompt():
    profile_name = ""
    print("=== Configuration prompt ===")
    while profile_name == "":
        profile_name = input("Enter profile name: ")
    ua = input("Enter user agent: ")
    if ua == "": 
        ua = "Enter user agent: "
    return Profile(
        profile_name, 
        "116", 
        ua,
        False,
        "",
        "",
        ""
        )
def load_profiles():
    loaded_profiles = []
    for root, dirs, files in os.walk("Profiles"):
        for filename in files:
            if filename == 'config.json':
                config_path = os.path.join(root, filename)

                # Load the JSON data from the config file
                with open(config_path, 'r') as config_file:
                    config_data = json.load(config_file)
# Create a Profile object from the loaded JSON data
                profile = Profile(
                    config_data['name'],
                    config_data['chromium_version'],
                    config_data['user_agent'],
                    config_data['proxy_flag'],
                    config_data['proxy_url'],
                    config_data['proxy_user'],
                    config_data['proxy_pass']
                )

                # Append the Profile object to the loaded_profiles list
                loaded_profiles.append(profile)

    return loaded_profiles

def update_prof_list():
    global loaded_profiles
    loaded_profiles = load_profiles()

def craft_command(profile:Profile):
    args = chromium_path
    if profile.user_agent != "":
        args += f" --user-agent='{profile.user_agent}'"
    args += f" --user-data-dir='{os.getcwd()}/Profiles/{profile.name}/user-data'"
    return args

def new_profile(profile:Profile):
    if not os.path.exists(f"Profiles/{profile.name}"):
        os.mkdir(os.getcwd() + "/Profiles/" + profile.name)
        os.mkdir(os.getcwd() + "/Profiles/" + profile.name + "/user-data")
        with open(os.getcwd() + "/Profiles/" + profile.name + "/config.json", 'w') as file:
        # Step 2: Write data to the file
            file.write(profile.dump_config())
    else: print("Profile with this name already exists!")
    update_prof_list()

def edit_profile(oldProfile:Profile, newProfile:Profile):
    if not os.path.exists(f"Profiles/{newProfile.name}") and oldProfile.name != newProfile.name:
        os.rename(os.getcwd() + "/Profiles/" + oldProfile.name, os.getcwd() + "/Profiles/" + newProfile.name)
    with open(os.getcwd() + "/Profiles/" + newProfile.name + "/config.json", 'w') as file:
        # Step 2: Write data to the file
        file.write(newProfile.dump_config())

def delete_profile(profile:Profile):
    if os.path.exists(f"Profiles/{profile.name}"):
        shutil.rmtree(os.getcwd() + "/Profiles/" + profile.name)
    update_prof_list()

def run_profile(profile:Profile):
    command_line = craft_command(profile=profile)
    proc = subprocess.Popen(shlex.split(command_line))
    active_processes.update({profile.name: proc})

def stop_profile(profile:Profile):
    active_processes[profile.name].terminate()
    active_processes.pop(profile.name)

# prof1 = config_prompt()
# new_instance(prof1)
# run_instance(prof1)
# prof2 = config_prompt()
# new_instance(prof2)
# run_instance(prof2)
# print(active_processes)
loaded_profiles = load_profiles()
for profile in loaded_profiles:
    print(profile.name)
edit_profile(loaded_profiles[0], Profile(loaded_profiles[0].name, "116", "test", False, "", "", ""))
for profile in loaded_profiles:
    print(profile.name)

# Create a new Chrome profile each time
# TODO os.system("/opt/homebrew/bin/chromium --proxy-server=socks5://142.54.237.34:4145 --user-agent='XD' --user-data-dir='Profiles/Name'")
# shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE - NOTE
# Check the result and print the output
# Perform actions or automation tasks
# ...

# Close the Chromium instance
#driver.quit()