parse-dynamic-roles
===================

This module allows objects on Parse to be access-restricted based on rules. You can define a set of rules and have this module create roles and ACLs dynamically based on those rules.

This is a very early version just copied out of the project where it was created. I will clean up the code going forward and extend the documentation. However, the module should work as is and you should be able to start using it following the instructions below.

How it works
------------

With dynamic roles, you can define rules that declare which objects can be read and written by who. When an object is saved, the rules are evaluated and depending on the object, the ACL of the object is modified, roles are created or changed, and referenced objects' access is adjusted.

These are the main types of entities that matter:

*   **Role-carrying objects (RCO)** are the core of the concept. If such an object is created, a role is created with the object that regulates access to the object itself and resources of the object. When the object is deleted, the role is deleted.

*   **Resources** are objects that are children of the RCO and inherit the role of the RCO. This way, whoever has access to the RCO, also has access to the resource.

*   **Members** are users who have access to the RCO and its children. They are users of the RCO’s role. To add a user as a member, the user is added to a relationship with the RCO that triggers him to be added as a user to the rule. The same is true for removal. Members can also be resources in scenarios where all members of a RCO have (read) access to other members.

*   **Join objects** connect members or resources with the RCO. If this is the case, the role is added to resources when the join object between the RCO and the resource is created / saved and members are added to roles when the join object between the RCO and the user is created / saved.

All these entities are linked together with a JSON description of rules. See below to learn how to set up dynamic roles.

Dynamic roles theoretically supports two modes: *immediate* and *deferred* rule execution. In various tests I experienced varying performance of Parse that resulted in regular timeouts using the immediate mode. Therefore, **the only mode currently supported is deferred**.

Installation
------------

1.  Copy the module or clone the github repository as a submodule into your project

        git submodule add https://github.com/stefanhenze/parse-dynamic-roles.git <path-to-parse-code>/cloud/parse-dynamic-roles/

1.  Require the parse-dynamic-roles module where you want to configure your rules and wherever you are using `Parse.Cloud.beforeSave` and `Parse.Cloud.afterSave` on the collections you want to assign dynamic roles to.

        var DynamicRoles = require('cloud/parse-dynamic-roles/dynamicRoles.js');

Set Up
------

1.  Declare the rules

    ```javascript
    var DynamicRoles = require('cloud/parse-dynamic-roles/dynamicRoles.js');
    var roleDefinitions = [
        {
            collection: 'Team',
            isRoleCarryingObject: true,
            isResource: true,
            ensureOwnerHasAccess: true,
            roleSpecs: [
                { roleType: 'teamLead', read: true, write: true },
                { roleType: 'teamMember', read: true, write: false }
            ]
        },
        ...
    ];
    ```

    For detailed description of the syntax for role definition see.

1.  Initialize dynamic roles.

    ```javascript
    DynamicRoles.configure(roleDefinitions, DynamicRoles.MODE.DEFERRED);
    ```

    `DynamicRoles.MODE.DEFERRED` is currently the only mode supported.

1.  Bind dynamic roles to the collection.

    ```javascript
    Parse.Cloud.beforeSave('Team', function(request, response) {
        return DynamicRoles.beforeSave(request, response);
    });

    Parse.Cloud.afterSave('Team', function(request) {
        DynamicRoles.afterSave(request);
    });
    ```

1.  Register the job `executeDynamicRoles` to run every minute.

Rule definition
---------------

Dynamic roles are configures with a set of rules that define which roles and ACLs are applied to wich objects. Dynamic roles needs to be initialized with an array of rules. Here are the possible rule definitions:

1.  Role carrying objects

    ```javascript
    {
        collection: 'RCOCollectionName',
        isRoleCarryingObject: true,
        isResource: true,
        ensureOwnerHasAccess: true,
        roleSpecs: [
            { roleType: 'roleName1', read: true, write: true },
            { roleType: 'roleName2', read: true, write: false }
        ]
    }
    ```

    *   `collection` is the name of the role carrying object collection.
    *   `isRoleCarryingObject` must be `true` here to declare the collection as an RCO.
    *   if `isResource` is `true`, the RCO not only defines how objects can be accessed, but the RCO itself becomes a resource and can be accessed according to the rules. By setting this to `false`, you can ensure that the RCO simply manages object access without being accessible itself.
    *   `ensureOwnerHasAccess` automatically sets read and write access to the object for the user that creates the object, independent of any roles applied.
    *   `roleSpecs` define the roles that get creates for the RCO and the access users have. You can define multiple roles. For each enty, a Parse role is created, named after the `roleType`, the collection and the object's ID. When members get added to access objects controlled by this RCO, they get added to these roles.

1.  Resources that point to the RCO

    ```javascript
    {
        collection: 'CollectionName',
        isResource: true,
        ensureOwnerHasAccess: true,
        roleCarryingObject: 'RCOCollectionName',
        getRoleCarryingObjectReference: function(obj) {
            return obj.get("team");
        }
    }
    ```

    *   This object is not an RCO, but becomes accessible by members controlled by an RCO.
    *   `collection` is the name of the resource object collection.
    *   `isResource` denotes that this is a resource.
    *   `roleCarryingObject` is the name of the RCO collection that controls access to this resource.
    *   `getRoleCarryingObjectReference` expects a function that gets the resource object as a parameter and returns the RCO. *There are multiple, inconsistent ways, to obtain references to RCOs throughout the framework. This needs some cleanup, stay tuned*.

1.  References from the RCO to resources

    ```javascript
    {
        collection: 'RCOCollectionName',
        isRoleCarryingObject: true,
        isResource: true,
        ensureOwnerHasAccess: true,
        roleSpecs: [
            { roleType: 'roleName1', read: true, write: true },
            { roleType: 'roleName2', read: true, write: false }
        ],
        references: [
            {
                collection: 'User',
                referencePointer: 'teamMember',
                memberRoleType: 'roleName1',
                isMember: true,
                isResource: true,
                roleSpecs: [
                    { roleType: 'roleName1', read: true, write: false }
                ]
            },
            {
                collection: 'User',
                referencePointer: 'teamLead',
                memberRoleType: 'roleName2',
                isMember: true,
                isResource: true,
                roleSpecs: [
                    { roleType: 'roleName2', read: true, write: false }
                ]
            }
        ]
    }
    ```

    This example defines a new role carrying object. As part of the RCO definition, references that are directly references from the RCO are also defined.

    *   `references` is an array of directly referenced objects.
    *   `references.collection` is the name of the referenced collection.
    *   `references.referencePointer` is the name of the attribute in the RCO collection that leads to the referenced entity.
    *   other attributes are the same as for regular resources.

1.  Join objects

    ```javascript
    {
        collection: 'JoinCollectionName',
        isResource: true,
        isMember: false,
        ensureOwnerHasAccess: true,
        roleCarryingObject: 'RCOCollectionName',
        getRoleCarryingObjectReference: function(obj) {
            return obj.get("team");
        },
        joinsWith: {
            collection: 'User',
            getJoinReference: function(obj) {
                return obj.get("user");
            },
            getMemberRoleType: function(obj) {
                return obj.get("roleType");
            },
            isMember: true,
            isResource: true,
            roleSpecs: [
                { roleType: 'roleName1', read: true, write: true },
                { roleType: 'roleName2', read: true, write: false }
            ]
        }
    }
    ```

    A join object is like a manual relation between two objects. In this example, the collection JoinCollectionName has a pointer .team to the RCO and a pointer .user to the resource / member. The role type is referenced through the attribute .roleType.

    *   `collection` is the name of the join collection.
    *   `joinsWith` expects an object that defines the join to the resource.
    *   `joinsWith.collection` is the name of the referenced collection.
    *   `getJoinReference` expects a function that returns a reference to the resource object given the join object as a parameter.
    *   `getMemberRoleType` expects a function that returns a role type string for the resource object given the join object as a parameter.


Shortcomings
------------

*   The framework is not totally consistent. Some rules accept other formats for references than others. This needs to be cleaned up.
*   References to resources without join objects must be direct from the RCO to the resource. It is currently not possible to have an RCO reference one resource that in turn references another resource.

Usage and Contribution
----------------------

Please feel free to use parse dynamic roles in your projects and let me know how it works for you. Contributions are most welcome, either as pull requests or by any other means.











