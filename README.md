# flexiWAN Official Repository

The official respository for flexiwan is in https://gitlab.com/flexiwangroup

# About flexiWAN

flexiWAN is the world's first open source [SD-WAN](https://flexiwan.com/). flexiWAN offers a complete SD-WAN solution comprising of flexiEdge (the edge router) and flexiManage (the central management system) with core SD-WAN functionality. Our mission is to democratize the SD-WAN Market through an open source & modular  SD-WAN solution lowering barriers to entry for companies to adopt it or offer services based on the flexiWAN SD-WAN solution. To learn more about the flexiWAN's unique approach to networking, visit the [flexiWAN](https://flexiwan.com/) website, and follow the company on [Twitter](https://twitter.com/FlexiWan) and [LinkedIn](https://www.linkedin.com/company/flexiwan).

To contact us please drop us an email at yourfriends@flexiwan.com, or for any general issue please use our [Google User Group](https://groups.google.com/a/flexiwan.com/forum/#!forum/flexiwan-users)

# flexiManage

This repository contains the flexiManage backend component from flexiWAN. flexiManage service is used for managing [flexiEdge devices](https://docs.flexiwan.com/overview/arch.html#flexiedge). It allows users to create users and accounts and manage the entire network inventory of the organizations in the account.

Our hosted service https://manage.flexiwan.com provides a free UI access to the flexiManage service where users can create an account and use up to 3 flexiEdge devices for free.

## What is included in this repository

The flexiManage backend component provides REST API for managing the flexiWAN network, configuring and connecting to the flexiWAN flexiEdge devices. 
The repository includes two git submodules which are used by the flexiWAN SaaS service and are not open. 

When pulling the flexiManage repository, 
these submodules would be seen as an empty directory:
* client - a git submodule for the flexiWAN SaaS UI. The UI provides the user side logic and design for managing the network. It uses REST to access flexiManage
* backend/billing - a git submodule for managing the flexiWAN SaaS billing

These submodules are not required for running the backend serivce and are used for the UI and Billing additions on top of flexiManage.
To experience the complete flexiWAN system, open a free account on our [hosted system](https://flexiwan.com/pricing).

## Install and use flexiManage locally

### Prerequisites
FlexiManage requires the following to run:
* Node.js v10+
* npm v6+
* MongoDB 4.0.9, running as a replica-set with 3 nodes on ports 27017, 27018, 27019
* Redis 5.0.5, running on port 6379
* A mailer application or trapper of your choice, running on port 1025 (Such as [python mailtrap](https://pypi.org/project/mailtrap/))

### Installing
##### Getting the source code:
```
mkdir flexiManage
cd flexiManage
git clone https://gitlab.com/flexiwangroup/fleximanage.git .
```

##### Installing dependencies:
```
cd backend
npm install
```

### Running
```
npm start
```

### Creating a user
To create your first user, use the procedure below:
1) Register a new user:
```
curl -X POST -k "https://local.flexiwan.com:3443/api/users/register" -H "accept: application/json" -H "Content-Type: application/json" -d "{\"accountName\":\"account\",\"userFirstName\":\"user\",\"userLastName\":\"lastname\",\"email\":\"user@example.com\",\"password\":\"xxxxxxxx\",\"userJobTitle\":\"eng\",\"userPhoneNumber\":\"\",\"country\":\"US\",\"companySize\":\"0-10\",\"serviceType\":\"Provider\",\"numberSites\":\"10\",\"companyType\":\"\",\"companyDesc\":\"\",\"captcha\":\"\"}"
```
2) You should get an email to user@example.com with a verification link. In the verification link, copy the id and t (token) parameters and execute the verification API:
```
curl -X POST -k "https://local.flexiwan.com:3443/api/users/verify-account" -H "accept: application/json" -H "Content-Type: application/json" -d "{\"id\":\"<id parameter in the verification link>\",\"token\":\"<token parameter in the verification link>\"}"
```
3) Execute a login API:
```
curl -X POST -sD - -k "https://local.flexiwan.com:3443/api/users/login" -H "accept: application/json" -H "Content-Type: application/json" -d "{\"username\":\"user@example.com\",\"password\":\"xxxxxxxx\",\"captcha\":\"\"}"
```
Check the response header and use the Refresh-JWT as bearer token for any REST API.
```
Refresh-JWT: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJfaWQiOiI1ZTh...TlNo
```
Check the documentation REST API section for more details.  You can create an access-key for your account API key.

### Documentation
For full documentation of flexiManage, please refer to [flexiManage documentation](https://docs.flexiwan.com/management/management-login.html).

## Versioning

FlexiManage uses [SemVer](https://semver.org/) scheme for versioning.

## License

This project is licensed under the GNU AGPLv3 License - see the [LICENSE.md](https://gitlab.com/flexiwangroup/fleximanage/blob/master/LICENSE) file for details

## Other Open Source Used

This project uses other Open Source components listed [here](https://gitlab.com/flexiwangroup/fleximanage/blob/master/OPENSOURCE.md).
