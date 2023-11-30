import platform
import os
import subprocess
from Model.Profile import Profile
import shlex, shutil
import json
from pathlib import Path
import sys

class Core():
    def __init__(self):
        self.user_data_root = "Profiles"
        self.loaded_profiles = []
        # self.chromium_path = 'E:\Studia\Praca\\thePrivator\local\chrome-win\chrome.exe'
        self.chromium_path = "/opt/homebrew/bin/chromium"
        print("===============")
        print(self.chromium_path)
        print("===============")

        self.active_processes = {}
        self.load_profiles()
        print(platform.platform())

    def config_prompt(self):
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
    def load_profiles(self):
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

        self.loaded_profiles = loaded_profiles

    def update_prof_list(self):
        self.loaded_profiles = self.load_profiles()

    def craft_command(self, profile:Profile):
        args = self.chromium_path
        if profile.user_agent != "":
            args += f" --user-agent='{profile.user_agent}'"
            
        datadir = Path(f"{os.getcwd()}/Profiles/{profile.name}/user-data")
        args += f" --user-data-dir='{datadir}'"
        return args

    def new_profile(self, profile:Profile):
        if not os.path.exists(Path(f"Profiles/{profile.name}")):
            os.mkdir(os.path.join(os.getcwd(), "Profiles", profile.name))
            os.mkdir(os.path.join(os.getcwd(), "Profiles", profile.name, "user-data"))
            with open(os.path.join(os.getcwd(), "Profiles", profile.name, "config.json"), 'w') as file:
            # Step 2: Write data to the file
                file.write(profile.dump_config())
        else: print("Profile with this name already exists!")
        self.update_prof_list()

    def edit_profile(self, oldProfile:Profile, newProfile:Profile):
        if not os.path.exists(f"Profiles/{newProfile.name}") and oldProfile.name != newProfile.name:
            os.rename(os.path.join(os.getcwd(), "Profiles", oldProfile.name),
                       os.path.join(os.getcwd(), "Profiles", newProfile.name))
        with open(os.path.join(os.getcwd(), "Profiles", newProfile.name, "config.json"), 'w') as file:
            # Step 2: Write data to the file
            file.write(newProfile.dump_config())

    def delete_profile(self, profile:Profile):
        if os.path.exists(f"Profiles/{profile.name}"):
            shutil.rmtree(os.getcwd() + "/Profiles/" + profile.name)
        self.update_prof_list()

    def run_profile(self, profile:Profile):
        command_line = self.craft_command(profile=profile)
        if sys.platform == 'win32':
            args = command_line
        else:
            args = shlex.split(command_line)
        
        print(args)

        proc = subprocess.Popen(args)
        self.active_processes.update({profile.name: proc})

    def stop_profile(self, profile:Profile):
        self.active_processes[profile.name].terminate()
        self.active_processes.pop(profile.name)



# Create a new Chrome profile each time
# TODO os.system("/opt/homebrew/bin/chromium --proxy-server=socks5://142.54.237.34:4145 --user-agent='XD' --user-data-dir='Profiles/Name'")
# shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE - NOTE
# Check the result and print the output
# Perform actions or automation tasks
# ...

# Close the Chromium instance
#driver.quit()